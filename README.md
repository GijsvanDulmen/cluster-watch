![logo](logo.png)
# ClusterWatch
Kubernetes watcher for cluster level changes like node and machine activity.
Send Slack messages of those activities.

# Install
Use the `/app/deployments` scripts. Make sure you create a secrets.yml and a namespace
called `cluster-watch`. Also you need to build the Docker images and make sure they are
correctly referende in de k8s/Deployment.