const EventEmitter = require('events');
const k8s = require('@kubernetes/client-node');

module.exports = class CoreApiWatcher extends EventEmitter {
    constructor(kubeConfig, watchExpr, listFn, logger) {
        super();

        this.watcher = new k8s.Watch(kubeConfig);

        this.watchExpr = watchExpr;
        this.listFn = listFn;
        this.logger = logger;
        this.cache = undefined;
    }

    onCreate(cb) { this.on("created", cb); }
    onUpdate(cb) { this.on("update", cb); }
    onDelete(cb) { this.on("delete", cb); }

    checkDeletionEvery(checkEveryMs) {
        setInterval(() => {
            this.listFn().then(res => {
                const names = this.collectNames(res);
                Object.keys(this.cache).forEach(name => {
                    if ( names[name] == undefined ) {
                        this.emit("delete", name);
                        delete this.cache[name];
                    }
                });
            });
        }, checkEveryMs);
    }

    collectNames(res) {
        let obj = {};
        res.body.items.forEach(item => {
            obj[item.metadata.name] = true;
        });
        return obj;
    }

    init() {
        this.listFn().then(res => {
            this.cache = this.collectNames(res);
            this.logger.info(this.watchExpr + " cache filled with " + Object.keys(this.cache).length + " items");
        });
    }

    watch() {
        this.watcher.watch(this.watchExpr, {}, (phase, obj) => {
            if ( this.cache != undefined ) {
                if ( this.cache[obj.metadata.name] == undefined ) {
                    this.emit("created", obj);
                    this.cache[obj.metadata.name] = true;
                } else {
                    // update!
                    this.emit("update", obj);
                }
            }
        }, (err) => {
            this.logger.error("error watching "+this.watchExpr+" - restarting in a few secs");
            this.logger.error(err);
            setTimeout(() => this.watch(), 1000*4);
        });
    };
}