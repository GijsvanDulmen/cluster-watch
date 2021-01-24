const CoreApiWatcher = require("./CoreApiWatcher");
const k8s = require('@kubernetes/client-node');

module.exports = class MachineConfigWatcher extends CoreApiWatcher {
    constructor(kubeConfig, logger) {
        const customObjectsApi = kubeConfig.makeApiClient(k8s.CustomObjectsApi);

        const group = "machineconfiguration.openshift.io";
        const version = "v1";
        const plural = "machineconfigs";

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