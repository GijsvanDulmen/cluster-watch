## Contributing

Use minikube for testing certain scenario's like adding and removing nodes:

```
minikube start --nodes 2 -p test-cluster-watch
```

Delete node:
```
minikube node delete -p test-cluster-watch test-cluster-watch-m02
minikube node delete -p test-cluster-watch test-cluster-watch-m03
```

Add node:
```
minikube node add -p test-cluster-watch --worker
kubectl label nodes test-cluster-watch-m03 node-role.kubernetes.io/worker=''
```