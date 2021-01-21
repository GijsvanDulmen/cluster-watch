#!/bin/bash

cd notifier
docker build -t gijsvandulmen/cluster-watch-notifier:latest .
docker push gijsvandulmen/cluster-watch-notifier:latest