// Copyright 2016-2025, Pulumi Corporation.  All rights reserved.
// Modified for the 4IR Solutions exercise: configurable service type, Redis metrics exporters,
// explicit Service labels/named ports, and the monitoring stack (monitoring.ts).

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

import { deployMonitoring } from "./monitoring"; // STEP A: comment out (see plan, Phase 2)

const config = new pulumi.Config();

// Replaces the stock `isMinikube` flag. Docker Desktop (kubeadm mode) implements LoadBalancer
// and reports hostname "localhost"; on kind/minikube set `serviceType NodePort` instead.
// Governs the FRONTEND only; Grafana has its own `grafanaServiceType` (monitoring.ts).
// ClusterIP is deliberately not offered: it is unreachable from Windows without a port-forward.
const serviceType = config.get("serviceType") ?? "LoadBalancer";
const validServiceTypes = ["LoadBalancer", "NodePort"];
if (!validServiceTypes.includes(serviceType)) {
    throw new Error(`serviceType must be one of ${validServiceTypes.join(", ")}; got "${serviceType}"`);
}
// Fixed NodePort so the URL is deterministic when serviceType is NodePort (range 30000-32767).
const frontendNodePort = config.getNumber("frontendNodePort") ?? 30080;

// Set explicitly on every app resource below. The stock example relies on the kubectl context's
// default namespace; if that pointed elsewhere, the ServiceMonitors, Probe FQDN and dashboard
// (which all assume this value) would silently match nothing. Single source of truth.
const appNamespace = "default";

const redisExporterImage = "oliver006/redis_exporter:v1.96.0";
const redisExporter: k8s.types.input.core.v1.Container = {
    // Turns redis `INFO` into Prometheus metrics on :9121. Same pod => localhost.
    name: "redis-exporter",
    image: redisExporterImage,
    env: [{ name: "REDIS_ADDR", value: "redis://localhost:6379" }],
    ports: [{ containerPort: 9121, name: "metrics" }],
    // Liveness, not readiness: a hung exporter is restarted on its own. A readiness probe here
    // would mark the whole Redis pod NotReady whenever the exporter is slow, taking Redis out of
    // its Service, i.e. letting a monitoring sidecar break the app. In Prometheus: a running
    // exporter that cannot reach Redis reports redis_up 0; a crash-looping exporter (which, like any
    // crashing container, does make the pod NotReady) shows as a missing/DOWN target.
    livenessProbe: { tcpSocket: { port: "metrics" }, initialDelaySeconds: 10, periodSeconds: 20 },
    resources: { requests: { cpu: "10m", memory: "32Mi" }, limits: { memory: "64Mi" } },
};

//
// REDIS LEADER.
//

const redisLeaderLabels = { app: "redis-leader" };
const redisLeaderDeployment = new k8s.apps.v1.Deployment("redis-leader", {
    // The stock example leaves metadata.labels unset, so `deployment.metadata.labels` is
    // undefined and the Services carried NO labels: a ServiceMonitor would match nothing.
    metadata: { namespace: appNamespace, labels: redisLeaderLabels },
    spec: {
        selector: { matchLabels: redisLeaderLabels },
        template: {
            metadata: { labels: redisLeaderLabels },
            spec: {
                containers: [
                    {
                        name: "redis-leader",
                        image: "redis:7", // pinned major: plain `redis` floats
                        resources: { requests: { cpu: "100m", memory: "100Mi" } },
                        ports: [{ containerPort: 6379, name: "redis" }],
                    },
                    redisExporter,
                ],
            },
        },
    },
});
const redisLeaderService = new k8s.core.v1.Service("redis-leader", {
    metadata: { name: "redis-leader", namespace: appNamespace, labels: redisLeaderLabels },
    spec: {
        // Two ports => both named. ServiceMonitor endpoints reference the NAME "metrics".
        ports: [
            { name: "redis", port: 6379, targetPort: "redis" },
            { name: "metrics", port: 9121, targetPort: "metrics" },
        ],
        selector: redisLeaderLabels,
    },
});

//
// REDIS REPLICA.
//

const redisReplicaLabels = { app: "redis-replica" };
const redisReplicaDeployment = new k8s.apps.v1.Deployment("redis-replica", {
    metadata: { namespace: appNamespace, labels: redisReplicaLabels },
    spec: {
        selector: { matchLabels: redisReplicaLabels },
        template: {
            metadata: { labels: redisReplicaLabels },
            spec: {
                containers: [
                    {
                        name: "replica",
                        image: "pulumi/guestbook-redis-replica", // upstream publishes no version tags
                        resources: { requests: { cpu: "100m", memory: "100Mi" } },
                        env: [{ name: "GET_HOSTS_FROM", value: "dns" }],
                        ports: [{ containerPort: 6379, name: "redis" }],
                    },
                    redisExporter,
                ],
            },
        },
    },
});
const redisReplicaService = new k8s.core.v1.Service("redis-replica", {
    metadata: { name: "redis-replica", namespace: appNamespace, labels: redisReplicaLabels },
    spec: {
        ports: [
            { name: "redis", port: 6379, targetPort: "redis" },
            { name: "metrics", port: 9121, targetPort: "metrics" },
        ],
        selector: redisReplicaLabels,
    },
});

//
// FRONTEND
//

const frontendLabels = { app: "frontend" };
const frontendDeployment = new k8s.apps.v1.Deployment("frontend", {
    metadata: { namespace: appNamespace, labels: frontendLabels },
    spec: {
        selector: { matchLabels: frontendLabels },
        replicas: 3,
        template: {
            metadata: { labels: frontendLabels },
            spec: {
                containers: [
                    {
                        name: "frontend",
                        image: "pulumi/guestbook-php-redis", // Apache/PHP: no /metrics, so it is probed
                        resources: { requests: { cpu: "100m", memory: "100Mi" } },
                        env: [{ name: "GET_HOSTS_FROM", value: "dns" }],
                        ports: [{ containerPort: 80, name: "http" }],
                    },
                ],
            },
        },
    },
});
const frontendService = new k8s.core.v1.Service("frontend", {
    metadata: { name: "frontend", namespace: appNamespace, labels: frontendLabels },
    spec: {
        type: serviceType,
        ports: [{
            name: "http",
            port: 80,
            targetPort: "http",
            ...(serviceType === "NodePort" ? { nodePort: frontendNodePort } : {}),
        }],
        selector: frontendLabels,
    },
});

// The stock `status.loadBalancer.ingress[0].ip` throws while the ingress list is still empty,
// and Docker Desktop reports `hostname` ("localhost"), not `ip`. Read it defensively.
// The NodePort branch derives from the Service too, so the output only exists once it does.
const PENDING = "pending (run `pulumi up --refresh`)";
export const frontendIp: pulumi.Output<string> =
    serviceType === "LoadBalancer"
        ? frontendService.status.apply((s) => {
              const ingress = s?.loadBalancer?.ingress?.[0];
              return ingress?.hostname || ingress?.ip || PENDING;
          })
        : frontendService.metadata.name.apply(() => `localhost:${frontendNodePort}`);

// Only prefix http:// onto a real address, never onto the "pending" hint.
export const frontendUrl = frontendIp.apply((host) => (host === PENDING ? PENDING : `http://${host}`));

//
// MONITORING (Prometheus + Grafana + blackbox-exporter) - see monitoring.ts.
// STEP A: comment out everything below this line.
//
const monitoring = deployMonitoring({
    appNamespace,
    // ServiceMonitors/Probe are created only after the Services they select exist.
    appDependencies: [frontendService, redisLeaderService, redisReplicaService],
});

export const grafanaUrl = monitoring.grafanaUrl;
export const grafanaAdminUser = monitoring.grafanaAdminUser;
// Secret: `pulumi stack output grafanaAdminPassword --show-secrets`
export const grafanaAdminPassword = monitoring.grafanaAdminPassword;
