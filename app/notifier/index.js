const winston = require('winston');
const { WebClient } = require('@slack/web-api');
const express = require('express');
const app = express();

const k8s = require('@kubernetes/client-node');

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

const slackToken = process.env.SLACK_TOKEN;
const slackChannel = process.env.SLACK_CHANNEL;
const slackApi = new WebClient(slackToken);

logger.info("using slack channel: " + slackChannel);

const coreV1Api = kc.makeApiClient(k8s.CoreV1Api);

const cache = {};
const taintTimeCache = {};
let namespaceCache = {};
let nodeCache = {};

const collectNames = res => {
    let obj = {};
    res.body.items.forEach(item => {
        obj[item.metadata.name] = true;
    });
    return obj;
};

coreV1Api.listNamespace().then(res => {
    namespaceCache = collectNames(res);
    logger.info("namespace cache filled with " + Object.keys(namespaceCache).length + " items");
});
coreV1Api.listNode().then(res => {
    nodeCache = collectNames(res);
    logger.info("node cache filled with " + Object.keys(nodeCache).length + " items");
});

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

const watch = new k8s.Watch(kc);

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
    HOURGLASS: ":hourglass:"
};

const intervals = {
    API_RESPONSE_TIMES: 1000*60*5,
    NODE_CHECK: 1000*60*5,
    WATCHDOG: 1000*60*60,
    STILL_TAINTED: 1000*60*5,
};

const sendMessageToSlack = (text, color, icon) => {
    slackApi.chat.postMessage({
        channel: slackChannel,
        attachments: [
            {
                text: icon + ' ' + text,
                color: color
            }
        ]
    }).then(res => {
        logger.info(res);
    }).catch(err => {
        logger.error(err);
    });
};

// watchdog every 1 hour
setInterval(() => {
    sendMessageToSlack("i am still running and should be after an hour", colors.BLUE, icons.INFO);
}, intervals.WATCHDOG);

// api server response time
const checkApiServerResponse = () => {
    const start = new Date();
    coreV1Api.readNamespace("default").then(res => {
        const end = new Date();
        sendMessageToSlack("api server response time `" + (end.getTime() - start.getTime()) + "ms`", colors.YELLOW, icons.HOURGLASS);
    });
};

setInterval(() => checkApiServerResponse(), intervals.API_RESPONSE_TIMES);
// checkApiServerResponse();

// check if nodes are gone!
setInterval(() => {
    coreV1Api.listNode().then(res => {
        const names = collectNames(res);
        Object.keys(nodeCache).forEach(name => {
            if ( names[name] == undefined ) {
                sendMessageToSlack("node deleted from cluster `"+name+"`", colors.RED, icons.ERROR);
                delete nodeCache[name];
            }
        });
    });
}, intervals.NODE_CHECK);

const watchWithReconnect = (watchExpr, handler) => {
    const startWatching = () => {
        watch.watch(watchExpr, {}, (phase, obj) => handler(phase, obj), (err) => {
            logger.error("error watching "+watchExpr+" - restarting in a few secs");
            logger.error(err);
            setTimeout(() => startWatching(), 1000*4);
        });
    };
    startWatching();
};

watchWithReconnect("/api/v1/namespaces", (phase, obj) =>{
    if ( Object.keys(namespaceCache).length != 0 ) {
        if ( namespaceCache[obj.metadata.name] == undefined ) {
            sendMessageToSlack("namespace created: `" + obj.metadata.name + "`", colors.BLUE, icons.INFO);
            namespaceCache[obj.metadata.name] = true;
        } else {
            if ( obj.status && obj.status.phase && obj.status.phase == 'Terminating' ) {
                sendMessageToSlack("namespace terminating: `" + obj.metadata.name + "`", colors.RED, icons.ERROR);
            }
        }
    }
});

watchWithReconnect("/api/v1/nodes", (phase, obj) =>{
    const name = obj.metadata.name;
    const spec = obj.spec;

    // check if new node
    if ( Object.keys(nodeCache).length > 0 ) {
        if ( nodeCache[name] == undefined ) {
            nodeCache[name] = true;
            sendMessageToSlack('Node `' + name + "` is added", colors.YELLOW, icons.INFO);
        }
    }

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
                        sendMessageToSlack('Node `' + name + "` still has the taint `" + taintKey + "`", colors.RED, icons.QUESTION);
                    }, intervals.STILL_TAINTED);

                    sendMessageToSlack('Node `' + name + "` has the taint `" + taintKey + "`", colors.RED, icons.ERROR);
                } else {
                    if ( taintTimeCache[name][taintKey] != undefined ) {
                        clearInterval(taintTimeCache[name][taintKey]);
                        delete taintTimeCache[name][taintKey];
                    }
                    sendMessageToSlack('Node `' + name + "` has no taint `" + taintKey + "` again!", colors.GREEN, icons.OK);
                }
            }
        });
    }

    // update cache
    cache[name] = currentTaints;
});

app.get('/live', (req, res) => res.send("OK")); // live and readiness probe

// starting
const port = 8080;
app.listen(port, () => logger.info("Started at port " + port));