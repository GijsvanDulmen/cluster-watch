const winston = require('winston');
const express = require('express');
const app = express();
const SlackBot = require('./lib/SlackBot.js');

const k8s = require('@kubernetes/client-node');
const NamespaceWatcher = require('./lib/NamespaceWatcher.js');
const NodeWatcher = require('./lib/NodeWatcher.js');

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

// setup slack bot
const bot = new SlackBot(process.env.SLACK_CHANNEL, process.env.SLACK_TOKEN, logger);

const coreV1Api = kc.makeApiClient(k8s.CoreV1Api);

const cache = {};
const taintTimeCache = {};

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
    HOURGLASS: ":hourglass:"
};

const intervals = {
    API_RESPONSE_TIMES: 1000*60*5,
    NODE_CHECK: 1000*60*5,
    WATCHDOG: 1000*60*60,
    STILL_TAINTED: 1000*60*5,
};

// watchdog every 1 hour
setInterval(() => {
    bot.send("i am still running and should be after an hour", colors.BLUE, icons.INFO);
}, intervals.WATCHDOG);

// api server response time
const checkApiServerResponse = () => {
    const start = new Date();
    coreV1Api.readNamespace("default").then(res => {
        const end = new Date();
        const ms = end.getTime() - start.getTime();
        if ( ms > 500 ) {
            bot.send("api server response time `" + ms + "ms`", colors.YELLOW, icons.HOURGLASS);
        }
    });
};

setInterval(() => checkApiServerResponse(), intervals.API_RESPONSE_TIMES);
checkApiServerResponse();

// const customObjectsApi = kc.makeApiClient(k8s.CustomObjectsApi);

// // listClusterCustomObject(group: string, version: string, plural: string, pretty?: string, _continue?: string, fieldSelector?: string, labelSelector?: string, limit?: number, resourceVersion?: string, timeoutSeconds?: number, watch?: boolean, options?: {
// customObjectsApi.listClusterCustomObject(
//     "machineconfiguration.openshift.io",
//     "v1",
//     "machineconfigpools",
// ).then(res => {
//     console.log(JSON.stringify(res, null ,2));
//     process.exit();
// }).catch(err => {
//     console.log(err);
//     // do nothing
// });

const ns = new NamespaceWatcher(kc, logger, 1000*5*60);
ns.onCreate(obj => bot.send("namespace created: `" + obj.metadata.name + "`", colors.BLUE, icons.INFO));
ns.onDelete(name => bot.send("namespace deleted: `" + name + "`", colors.RED, icons.ERROR));
ns.setup();

const checkTaints = obj => {
    const name = obj.metadata.name;
    const spec = obj.spec;

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
                        bot.send('Node `' + name + "` still has the taint `" + taintKey + "`", colors.RED, icons.QUESTION);
                    }, intervals.STILL_TAINTED);

                    bot.send('Node `' + name + "` has the taint `" + taintKey + "`", colors.RED, icons.ERROR);
                } else {
                    if ( taintTimeCache[name][taintKey] != undefined ) {
                        clearInterval(taintTimeCache[name][taintKey]);
                        delete taintTimeCache[name][taintKey];
                    }
                    bot.send('Node `' + name + "` has no taint `" + taintKey + "` again!", colors.GREEN, icons.OK);
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
    Object.keys(taintTimeCache[name]).forEach(taintKey => {
        clearInterval(taintTimeCache[name][taintKey]);
    });
    delete taintTimeCache[name];
});
n.onCreate(obj => {
    bot.send('Node `' + obj.metadata.name + "` is added", colors.YELLOW, icons.INFO)
    checkTaints(obj);
});
n.onUpdate(obj => checkTaints(obj));
n.setup();

app.get('/live', (req, res) => res.send("OK")); // live and readiness probe

// starting
const port = 8080;
app.listen(port, () => logger.info("Started at port " + port));
