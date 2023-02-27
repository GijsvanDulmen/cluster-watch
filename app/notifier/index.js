const winston = require('winston');
const express = require('express');
const app = express();
const SlackBot = require('./lib/SlackBot.js');

// constants
const colors = require('./lib/Colors');
const icons = require('./lib/Icons.js');

const EventManager = require('./lib/EventManager');
const Event = require('./lib/Event');

const k8s = require('@kubernetes/client-node');
const NamespaceWatcher = require('./lib/NamespaceWatcher.js');
const NodeWatcher = require('./lib/NodeWatcher.js');
const MachineConfigPoolWatcher = require('./lib/MachineConfigPoolWatcher.js');
const MachineConfigWatcher = require('./lib/MachineConfigWatcher.js');
const InstallPlanWatcher = require('./lib/InstallPlanWatcher.js');

// setup logger
const logger = winston.createLogger({
    level: 'info',
    transports: []
});

logger.add(new winston.transports.Console({
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.colorize(),
        winston.format.simple()
    )
}));

// setup kubernetes
const kc = new k8s.KubeConfig();

if ( process.env.KUBERNETES_SERVICE_HOST ) {
    kc.loadFromCluster();
} else {
    kc.loadFromDefault();
}

// check for openshift
let enableOpenshift = true;
if ( process.env.DISABLE_OPENSHIFT != undefined
    && process.env.DISABLE_OPENSHIFT == "true") {
    enableOpenshift = false;
}
logger.info("openshift support enabled: " + enableOpenshift);

let ignoreNamespaces = [];
if ( process.env.IGNORE_NAMESPACES != undefined ) {
    ignoreNamespaces.push(...process.env.IGNORE_NAMESPACES.split(","));
    logger.info("ignoring namespaces: " + process.env.IGNORE_NAMESPACES);
}

// setup slack bot
const specs = [
    {
        bot: new SlackBot(process.env.SLACK_CHANNEL, process.env.SLACK_TOKEN, logger),
        filter: false
    }
];

if ( process.env.NODE_ROLES_SLACK_CHANNEL ) {
    const channelPerNodeRole = JSON.parse(process.env.NODE_ROLES_SLACK_CHANNEL);
    channelPerNodeRole.forEach(channel => {
        specs.push({
            bot: new SlackBot(channel.channel, process.env.SLACK_TOKEN, logger),
            filter: true,
            keys: [
                'nodes.' + channel.role // only worker node messages
            ]
        })
    })
}

console.log(specs);

const eventManager = new EventManager(1500, specs);

const cache = {};
const taintTimeCache = {};
const nodeRoleCache = {};

const taintsToWatch = {
    NotReady: 'node.kubernetes.io/not-ready',
    Unreachable: 'node.kubernetes.io/unreachable',
    OutOfDisk: 'node.kubernetes.io/out-of-disk',
    MemoryPressure: 'node.kubernetes.io/memory-pressure',
    DiskPressure: 'node.kubernetes.io/disk-pressure',
    NetworkUnavailable: 'node.kubernetes.io/network-unavailable',
    Unschedulable: 'node.kubernetes.io/unschedulable',
    Uninitialized: 'node.cloudprovider.kubernetes.io/uninitialized'
};

let watchdogTimeout = 1000*60*60;
if ( process.env.WATCHDOG_SECONDS != undefined ) {
    watchdogTimeout = 1000*parseInt(process.env.WATCHDOG_SECONDS);
}

const intervals = {
    API_RESPONSE_TIMES: 1000*60*5,
    NODE_CHECK: 1000*5,
    WATCHDOG: watchdogTimeout,
    STILL_TAINTED: 1000*60*5,
};

// watchdog every 1 hour
setInterval(() => {
    const event = new Event("Watchdog", "i am still running", colors.BLUE, icons.INFO, 'watchdog', 'watchdog');
    eventManager.add(event);
}, intervals.WATCHDOG);

// machine config pool
if ( enableOpenshift ) {
    const mcp = new MachineConfigPoolWatcher(kc, logger);
    const mcpCache = {};
    const statusFieldsToMonitor = [
        "degradedMachineCount",
        "machineCount",
        "observedGeneration",
        "readyMachineCount",
        "unavailableMachineCount",
        "updatedMachineCount"
    ];

    mcp.onInit(obj => {
        const name = obj.metadata.name;
        mcpCache[name] = {};
        statusFieldsToMonitor.forEach(field => {
            mcpCache[name][field] = obj.status[field];
        });
        logger.info(name + ": " + JSON.stringify(mcpCache[name]));
    });
    mcp.onUpdate(obj => {
        const name = obj.metadata.name;
        if ( mcpCache[name] == undefined ) {
            mcpCache[name] = {};
        }

        statusFieldsToMonitor.forEach(field => {
            if ( mcpCache[name][field] != undefined ) {
                if ( mcpCache[name][field] != obj.status[field] ) {
                    const groupHeader = "MachineConfigPool `"+name+"`";
                    const detailMessage = "`"+field+"` changed from `"+mcpCache[name][field]+"` to `"+obj.status[field]+"`";
                    const event = new Event(groupHeader, detailMessage, colors.YELLOW, icons.INFO, 'machineconfigpool.'+name, ['machineconfigpool', 'machineconfigpool.'+name]);
                    eventManager.add(event)
                }
            }
            mcpCache[name][field] = obj.status[field];
        });
    });
    mcp.setup();

    // machine config watcher
    const mc = new MachineConfigWatcher(kc, logger);
    mc.onCreate(obj => {
        const name = obj.metadata.name;
        const groupHeader = "New MachineConfig `"+name+"` available";
        const detailMessage = "New MachineConfig `"+name+"` available";
        const event = new Event(groupHeader, detailMessage, colors.YELLOW, icons.INFO, 'machineconfig.'+name, ['machineconfig', 'machineconfig.'+name]);
        eventManager.add(event);
    });
    mc.setup();
    
    // installplan watcher
    const ipw = new InstallPlanWatcher(kc, logger);
    // ipw.onInit(obj => {
    ipw.onCreate(obj => {
        let versions = ' for ';
        if ( obj.spec.clusterServiceVersionNames ) {
            versions = ' for `'+obj.spec.clusterServiceVersionNames.join("`,`")+'`';
        }

        let icon;
        let color;

        if ( obj.spec.approved ) {
            color = colors.RED;
            icon = icons.ERROR;
        } else if ( obj.spec.approved ) {
            color = colors.GREEN;
            if ( obj.spec.approval != 'Automatic' ) {
                icon = icons.QUESTION;
            } else {
                icon = icons.INFO;
            }
        }

        const detailMessage = "New InstallPlan in namespace `"+obj.metadata.namespace+"` available with approval on `"+obj.spec.approval+"` and approved `"+obj.spec.approved+"`" + versions;
        const groupHeader = 'InstallPlans';
        const event = new Event(groupHeader, detailMessage, color, icon, 'installplan', 'installplane');
        eventManager.add(event);
    });
    ipw.setup();
}

// namespaces
const ns = new NamespaceWatcher(kc, logger, 1000*5*60);

const isIgnoreNamespace = ns => {
    let ignore = false;
    ignoreNamespaces.forEach(ignoreNamespace => {
        if ( ns.indexOf(ignoreNamespace) != -1 ) {
            ignore = true;
        }
    });
    return ignore;
};

ns.onCreate(obj => {
    if ( !isIgnoreNamespace(obj.metadata.name) ) {
        const name = obj.metadata.name;
        const groupHeader = "Namespaces";
        const detailMessage = "Created: `" + name + "`";
        const event = new Event(groupHeader, detailMessage, colors.BLUE, icons.INFO, 'namespace', ['namespace', 'namespace.'+name]);
        eventManager.add(event);
    }
});
ns.onDelete(name => {
    if ( !isIgnoreNamespace(name) ) {
        const groupHeader = "Namespaces";
        const detailMessage = "Deleted: `" + name + "`";
        const event = new Event(groupHeader, detailMessage, colors.BLUE, icons.WAVE, 'namespace', ['namespace', 'namespace.'+name]);
        eventManager.add(event);
    }
});
ns.setup();

// api server response time
const checkApiServerResponse = () => {
    ns.checkApiServerResponse(ms => {
        if ( ms > 500 ) {
            const groupHeader = "API Server";
            const detailMessage = "High response time of `" + ms + "ms`!";
            const event = new Event(groupHeader, detailMessage, colors.YELLOW, icons.HOURGLASS, 'apiserver', ['apiserver', 'apiserver.slow']);
            eventManager.add(event);
        }
    })
};

setInterval(() => checkApiServerResponse(), intervals.API_RESPONSE_TIMES);
// checkApiServerResponse();

const updateNodeRoles = obj => {
    const name = obj.metadata.name;

    nodeRoleCache[name] = [];

    // update role
    if ( obj.metadata.labels
        && obj.metadata.labels ) {
        Object.keys(obj.metadata.labels).forEach(label => {
            const searchStr = "node-role.kubernetes.io/";
            if ( label.indexOf(searchStr) != -1 ) {
                nodeRoleCache[name].push(label.substr(searchStr.length));
            }
        });
    }
};

const getRoleNodeStr = name => {
    let nodeRoleString = '';
    if ( nodeRoleCache[name] && nodeRoleCache[name].length > 0 ) {
        nodeRoleString = ' roles `'+nodeRoleCache[name].join('`/`')+'`';
    }
    return nodeRoleString;
};

const getRoleNodeFilterKeys = name => {
    let filterKeys = [];
    if ( nodeRoleCache[name] && nodeRoleCache[name].length > 0 ) {
        filterKeys.push(...nodeRoleCache[name]);
    }
    return filterKeys;
};

const checkTaints = obj => {
    const name = obj.metadata.name;
    const spec = obj.spec;

    updateNodeRoles(obj);

    // check taints
    let currentTaints = {};
    Object.keys(taintsToWatch).forEach(taintKey => {
        let hasTaint = false;
        if ( spec.taints != undefined ) {
            spec.taints.forEach(taint => {
                if ( taint.key == taintsToWatch[taintKey] ) {
                    hasTaint = true;
                }
            });
        }
        currentTaints[taintKey] = hasTaint;
    });

    // fill
    if ( taintTimeCache[name] == undefined ) {
        taintTimeCache[name] = {};             
    }

    if ( cache[name] != undefined ) {
        // detect changes 
        Object.keys(taintsToWatch).forEach(taintKey => {
            if ( cache[name][taintKey] !== currentTaints[taintKey] ) {
                logger.info("node " + name + " taint " + taintKey + " is " + currentTaints[taintKey]);

                const filterKeys = getRoleNodeFilterKeys(name).map(v => 'nodes.'+v);
                filterKeys.push('taints');

                const roles = getRoleNodeStr(name);

                const groupHeader = 'Node `' + name + "`"+roles;
                
                if ( currentTaints[taintKey] ) {
                    // add time as a marker
                    taintTimeCache[name][taintKey] = setInterval(() => {
                        const detailMessage = "Still has the taint `" + taintKey + "`";
                        const event = new Event(groupHeader, detailMessage, colors.RED, icons.QUESTION, 'nodes.'+name, filterKeys);
                        eventManager.add(event);
                    }, intervals.STILL_TAINTED);

                    const detailMessage = "Tainted `" + taintKey + "`";
                    const event = new Event(groupHeader, detailMessage, colors.RED, icons.ERROR, 'nodes.'+name, filterKeys);
                    eventManager.add(event);
                } else {
                    if ( taintTimeCache[name][taintKey] != undefined ) {
                        clearInterval(taintTimeCache[name][taintKey]);
                        delete taintTimeCache[name][taintKey];
                    }

                    const detailMessage = "Taint removed `" + taintKey + "`";
                    const event = new Event(groupHeader, detailMessage, colors.GREEN, icons.OK, 'nodes.'+name, filterKeys);
                    eventManager.add(event);
                }
            }
        });
    }

    // update cache
    cache[name] = currentTaints;
};

// watch nodes
const n = new NodeWatcher(kc, logger, intervals.NODE_CHECK);
n.onDelete(name => {
    const filterKeys = getRoleNodeFilterKeys(name).map(v => 'nodes.'+v);
    filterKeys.push('nodes');

    const roles = getRoleNodeStr(name);
    const groupHeader = 'Node `' + name + "`"+roles;
    const detailMessage = 'Node is deleted';
    const event = new Event(groupHeader, detailMessage, colors.YELLOW, icons.WAVE, 'nodes.'+name, filterKeys);
    eventManager.add(event);

    Object.keys(taintTimeCache[name]).forEach(taintKey => {
        clearInterval(taintTimeCache[name][taintKey]);
    });
    delete taintTimeCache[name];
    delete nodeRoleCache[name];
});
n.onCreate(obj => {
    updateNodeRoles(obj);
    
    const name = obj.metadata.name;
    const filterKeys = getRoleNodeFilterKeys(name).map(v => 'nodes.'+v);
    filterKeys.push('nodes');

    const roles = getRoleNodeStr(name);

    const groupHeader = 'Node `' + name + "`"+roles;
    const detailMessage = 'Node is added';
    const event = new Event(groupHeader, detailMessage, colors.YELLOW, icons.INFO, 'nodes.'+name, filterKeys);
    eventManager.add(event);

    checkTaints(obj);
});
n.onInit(obj => updateNodeRoles(obj));
n.onUpdate(obj => {
    updateNodeRoles(obj);
    checkTaints(obj);
});
n.setup();

app.get('/live', (req, res) => res.send("OK")); // live and readiness probe

// starting
const port = 8080;
app.listen(port, () => logger.info("Started at port " + port));
