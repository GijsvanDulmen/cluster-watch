const CoreApiWatcher = require("./CoreApiWatcher");
const k8s = require('@kubernetes/client-node');

module.exports = class InstallPlanWatcher extends CoreApiWatcher {
    constructor(kubeConfig, logger) {
        const customObjectsApi = kubeConfig.makeApiClient(k8s.CustomObjectsApi);

        const group = "operators.coreos.com";
        const version = "v1alpha1";
        const plural = "installplans";

        const watchExpr = "/apis/"+group+"/"+version+"/"+plural;
        super(kubeConfig, watchExpr, () => {
            return customObjectsApi.listClusterCustomObject(
                group,
                version,
                plural,
            );
        }, logger);
    }

    setup() {
        this.init();
        this.watch();
    }
}