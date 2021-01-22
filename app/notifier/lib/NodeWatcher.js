const CoreApiWatcher = require("./CoreApiWatcher");
const k8s = require('@kubernetes/client-node');

module.exports = class NodeWatcher extends CoreApiWatcher {
    constructor(kubeConfig, logger, checkEvery) {
        const coreV1Api = kubeConfig.makeApiClient(k8s.CoreV1Api);
        super(kubeConfig, "/api/v1/nodes", () => coreV1Api.listNode(), logger);
        this.checkEvery = checkEvery;
    }

    setup() {
        this.init();
        this.watch();
        this.checkDeletionEvery(this.checkEvery);
    }
}