#!/bin/bash

kubectl taint nodes test-cluster-watch-m02 node.kubernetes.io/not-ready=true:NoSchedule --overwrite=true
kubectl taint nodes test-cluster-watch-m02 node.kubernetes.io/disk-pressure=true:NoSchedule --overwrite=true

kubectl label nodes test-cluster-watch-m03 node-role.kubernetes.io/worker='' --overwrite=true

kubectl taint nodes test-cluster-watch-m03 node.kubernetes.io/not-ready=true:NoSchedule --overwrite=true

sleep 0.2

kubectl create ns test12357
kubectl create ns ns44457
kubectl create ns abc57
sleep 0.2

kubectl delete ns test12357
kubectl delete ns ns44457
kubectl delete ns abc57

kubectl taint nodes test-cluster-watch-m02 node.kubernetes.io/not-ready=true:NoSchedule- --overwrite=true
kubectl taint nodes test-cluster-watch-m02 node.kubernetes.io/disk-pressure=true:NoSchedule- --overwrite=true

kubectl taint nodes test-cluster-watch-m03 node.kubernetes.io/not-ready=true:NoSchedule- --overwrite=true