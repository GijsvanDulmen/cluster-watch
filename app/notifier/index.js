const winston = require('winston');
const express = require('express');
const app = express();
const SlackBot = require('./lib/SlackBot.js');

const k8s = require('@kubernetes/client-node');
const NamespaceWatcher = require('./lib/NamespaceWatcher.js');
const NodeWatcher = require('./lib/NodeWatcher.js');
const MachineConfigPoolWatcher = require('./lib/MachineConfigPoolWatcher.js');
const MachineConfigWatcher = require('./lib/MachineConfigWatcher.js');

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
console.log(process.env.DISABLE_OPENSHIFT);
if ( process.env.DISABLE_OPENSHIFT != undefined
    && process.env.DISABLE_OPENSHIFT == "true") {
    enableOpenshift = false;
}
logger.info("openshift support enabled: " + enableOpenshift);

// setup slack bot
const bot = new SlackBot(process.env.SLACK_CHANNEL, process.env.SLACK_TOKEN, logger);

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

const colors = {
    RED: '#FF0000',
    GREEN: '#078107',
    BLUE: '#06A6D1',
    YELLOW: '#EDC707'
};

const icons = {
    ERROR: ':bangbang:',
    OK: ":white_check_mark:",
    INFO: ":building_construction:",
    QUESTION: ":question:",
    HOURGLASS: ":hourglass:",
    WAVE: ":wave:"
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
    bot.send("i am still running", colors.BLUE, icons.INFO);
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
                    bot.send("MachineConfigPool `"+name+"` field `"+field+"` changed from `"+mcpCache[name][field]+"` to `"+obj.status[field]+"`", colors.YELLOW, icons.INFO);
                }
            }
            mcpCache[name][field] = obj.status[field];
        });
    });
    mcp.setup();

    // machine config watcher
    const mc = new MachineConfigWatcher(kc, logger);
    mc.onCreate(obj => {
        bot.send("New MachineConfig `"+obj.metadata.name+"` available", colors.YELLOW, icons.INFO);
    });
    mc.setup();
}

// namespaces
const ns = new NamespaceWatcher(kc, logger, 1000*5*60);
ns.onCreate(obj => bot.send("namespace created: `" + obj.metadata.name + "`", colors.BLUE, icons.INFO));
ns.onDelete(name => bot.send("namespace deleted: `" + name + "`", colors.BLUE, icons.WAVE));
ns.setup();

// api server response time
const checkApiServerResponse = () => {
    ns.checkApiServerResponse(ms => {
        if ( ms > 500 ) {
            bot.send("high api server response time of `" + ms + "ms`!", colors.YELLOW, icons.HOURGLASS);
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
    console.log(nodeRoleString);
    return nodeRoleString;
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
                if ( currentTaints[taintKey] ) {
                    // add time as a marker
                    taintTimeCache[name][taintKey] = setInterval(() => {
                        bot.send('Node `' + name + "`"+getRoleNodeStr(name)+" still has the taint `" + taintKey + "`", colors.RED, icons.QUESTION);
                    }, intervals.STILL_TAINTED);

                    bot.send('Node `' + name + "`"+getRoleNodeStr(name)+" tainted `" + taintKey + "`", colors.RED, icons.ERROR);
                } else {
                    if ( taintTimeCache[name][taintKey] != undefined ) {
                        clearInterval(taintTimeCache[name][taintKey]);
                        delete taintTimeCache[name][taintKey];
                    }
                    bot.send('Node `' + name + "`"+getRoleNodeStr(name)+" untainted `" + taintKey + "` again!", colors.GREEN, icons.OK);
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
    bot.send('Node `' + name + "` " + getRoleNodeStr(name) + " deleted", colors.YELLOW, icons.WAVE)

    Object.keys(taintTimeCache[name]).forEach(taintKey => {
        clearInterval(taintTimeCache[name][taintKey]);
    });
    delete taintTimeCache[name];
    delete nodeRoleCache[name];
});
n.onCreate(obj => {
    updateNodeRoles(obj);
    
    bot.send('Node `' + obj.metadata.name + "` added" + getRoleNodeStr(obj.metadata.name), colors.YELLOW, icons.INFO)
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
