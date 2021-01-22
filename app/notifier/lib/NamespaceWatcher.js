const CoreApiWatcher = require("./CoreApiWatcher");
const k8s = require('@kubernetes/client-node');

module.exports = class NamespaceWatcher extends CoreApiWatcher {
    constructor(kubeConfig, logger, checkEvery) {
        const coreV1Api = kubeConfig.makeApiClient(k8s.CoreV1Api);
        super(kubeConfig, "/api/v1/namespaces", () => coreV1Api.listNamespace(), logger);
        this.checkEvery = checkEvery;
    }

    setup() {
        this.init();
        this.watch();
        this.checkDeletionEvery(this.checkEvery);
    }
}