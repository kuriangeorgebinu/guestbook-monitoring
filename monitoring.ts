/**
 * monitoring.ts - the observability stack for the Guestbook, in the `monitoring` namespace.
 *
 * Contract with index.ts (the ServiceMonitors depend on it):
 *   - redis Services carry labels app=redis-leader / app=redis-replica;
 *   - each redis Service exposes a port NAMED "metrics" (9121, redis_exporter sidecar);
 *   - the frontend answers on http://frontend.<appNamespace>.svc.cluster.local:80/.
 */

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";

import { createGuestbookDashboard } from "./dashboard";

const config = new pulumi.Config();

// Pinned: a re-run must resolve exactly the charts that were tested.
const KUBE_PROMETHEUS_STACK_VERSION = "92.16.1";
const BLACKBOX_EXPORTER_VERSION = "11.20.2";
const HELM_REPO = "https://prometheus-community.github.io/helm-charts";

// The release name is also the `release` label value the chart would select on by default.
const KPS_RELEASE = "kube-prometheus-stack";
const MONITORING_NAMESPACE = "monitoring";
const GRAFANA_PORT = 3000; // not the chart default 80: the frontend already owns localhost:80

export interface MonitoringArgs {
    appNamespace?: string;
    appDependencies?: pulumi.Resource[];
}

export interface MonitoringOutputs {
    grafanaUrl: pulumi.Output<string>;
    grafanaAdminUser: pulumi.Output<string>;
    grafanaAdminPassword: pulumi.Output<string>;
}

export function deployMonitoring(args: MonitoringArgs = {}): MonitoringOutputs {
    const appNamespace = args.appNamespace ?? "default";
    const appDeps = args.appDependencies ?? [];

    // ------------------------------------------------------------------ access
    const grafanaServiceType = config.get("grafanaServiceType") ?? "NodePort";
    if (grafanaServiceType !== "NodePort" && grafanaServiceType !== "LoadBalancer") {
        throw new Error(`grafanaServiceType must be "NodePort" or "LoadBalancer", got "${grafanaServiceType}"`);
    }
    const grafanaNodePort = config.getNumber("grafanaNodePort") ?? 32000;
    const grafanaHost = config.get("grafanaHost") ?? "localhost";

    // ------------------------------------------------------- namespace + creds
    const ns = new k8s.core.v1.Namespace("monitoring", {
        metadata: { name: MONITORING_NAMESPACE },
    });

    const adminPassword = new random.RandomPassword("grafana-admin-password", {
        length: 24,
        special: true,
        overrideSpecial: "-_", // nothing that needs escaping in PowerShell or YAML
    });

    // Owned by Pulumi, read by the chart via grafana.admin.existingSecret, so the password
    // never sits in the Helm release values. Same namespace as the release, chart's key names.
    const adminSecret = new k8s.core.v1.Secret("grafana-admin", {
        metadata: { name: "grafana-admin", namespace: ns.metadata.name },
        type: "Opaque",
        stringData: { "admin-user": "admin", "admin-password": adminPassword.result },
    });

    // ------------------------------------------------- kube-prometheus-stack
    const kubePrometheusStack = new k8s.helm.v3.Release(KPS_RELEASE, {
        name: KPS_RELEASE,
        chart: "kube-prometheus-stack",
        version: KUBE_PROMETHEUS_STACK_VERSION,
        namespace: ns.metadata.name,
        repositoryOpts: { repo: HELM_REPO },
        timeout: 1200, // ceiling only: abort earlier if the host runs out of memory (see plan, Phase 4)
        values: {
            alertmanager: { enabled: false }, // not required by the brief; saves memory

            // Docker Desktop runs these inside its VM, not as pods: their targets would be
            // permanently DOWN and make the verification step look broken.
            kubeControllerManager: { enabled: false },
            kubeScheduler: { enabled: false },
            kubeEtcd: { enabled: false },
            kubeProxy: { enabled: false },

            prometheusOperator: {
                resources: { requests: { cpu: "20m", memory: "96Mi" }, limits: { memory: "256Mi" } },
            },

            // Laptop fit (an 8 GB PC): neither is needed by the brief, the dashboard or the checks.
            // Pod CPU/memory comes from the kubelet's cAdvisor endpoint, which stays scraped
            // (kubelet ServiceMonitor, cAdvisor: true by default). node-exporter also crash-loops on
            // Docker Desktop ("path / is mounted on / but it is not a shared or slave mount").
            nodeExporter: { enabled: false },
            kubeStateMetrics: { enabled: false },

            prometheus: {
                prometheusSpec: {
                    retention: "6h",
                    scrapeInterval: "30s",
                    // 768Mi keeps monitoring limits at ~1.7 GB, leaving headroom in a 4 GB Docker VM
                    // (8 GB laptop) for the app and the Kubernetes system pods.
                    resources: { requests: { cpu: "100m", memory: "400Mi" }, limits: { memory: "768Mi" } },
                    // No storageSpec on purpose: without one the operator uses emptyDir (no PVCs on a
                    // laptop cluster). Metrics are lost when the Prometheus pod restarts.

                    // THE selector gotcha: left true, Prometheus only selects ServiceMonitors /
                    // Probes labelled `release: kube-prometheus-stack`, and a miss is silent.
                    serviceMonitorSelectorNilUsesHelmValues: false,
                    probeSelectorNilUsesHelmValues: false,
                },
            },

            grafana: {
                admin: { existingSecret: "grafana-admin", userKey: "admin-user", passwordKey: "admin-password" },
                service: {
                    type: grafanaServiceType,
                    port: GRAFANA_PORT,
                    targetPort: 3000,
                    ...(grafanaServiceType === "NodePort" ? { nodePort: grafanaNodePort } : {}),
                },
                persistence: { enabled: false },
                // 256Mi was OOMKilled on every start (database migrations + plugin load); 512Mi is enough.
                resources: { requests: { cpu: "50m", memory: "256Mi" }, limits: { memory: "512Mi" } },
                sidecar: {
                    dashboards: {
                        enabled: true,
                        label: "grafana_dashboard",
                        labelValue: "1",
                        searchNamespace: MONITORING_NAMESPACE,
                    },
                },
            },
        },
    }, { dependsOn: [ns, adminSecret] });

    // ------------------------------------------------------- blackbox-exporter
    const blackboxExporter = new k8s.helm.v3.Release("blackbox-exporter", {
        name: "blackbox-exporter",
        chart: "prometheus-blackbox-exporter",
        version: BLACKBOX_EXPORTER_VERSION,
        namespace: ns.metadata.name,
        repositoryOpts: { repo: HELM_REPO },
        timeout: 300,
        values: {
            fullnameOverride: "blackbox-exporter", // stable Service name for the Probe below
            config: {
                modules: {
                    http_2xx: {
                        prober: "http",
                        timeout: "5s",
                        http: { preferred_ip_protocol: "ip4", valid_status_codes: [200, 301, 302] },
                    },
                },
            },
            resources: { requests: { cpu: "10m", memory: "32Mi" }, limits: { memory: "64Mi" } },
        },
    }, { dependsOn: ns });

    // --------------------------------------------- redis_exporter ServiceMonitors
    // Discovery comes from the two `...SelectorNilUsesHelmValues: false` flags above, NOT from the
    // `release` label below. The label is belt-and-braces only: copy this pattern without the
    // flags and Prometheus silently ignores these resources.
    for (const app of ["redis-leader", "redis-replica"]) {
        new k8s.apiextensions.CustomResource(`${app}-servicemonitor`, {
            apiVersion: "monitoring.coreos.com/v1",
            kind: "ServiceMonitor",
            metadata: { name: app, namespace: MONITORING_NAMESPACE, labels: { release: KPS_RELEASE } },
            spec: {
                namespaceSelector: { matchNames: [appNamespace] }, // Services live in `default`
                selector: { matchLabels: { app } },
                jobLabel: "app",                                    // job="redis-leader"
                endpoints: [{ port: "metrics", path: "/metrics", interval: "30s" }], // port NAME
            },
        // The ServiceMonitor CRD ships with the chart: without this, "no matches for kind".
        }, { dependsOn: [kubePrometheusStack, ...appDeps] });
    }

    // ------------------------------------------------------ frontend Probe (blackbox)
    new k8s.apiextensions.CustomResource("frontend-probe", {
        apiVersion: "monitoring.coreos.com/v1",
        kind: "Probe",
        metadata: { name: "frontend", namespace: MONITORING_NAMESPACE, labels: { release: KPS_RELEASE } },
        spec: {
            jobName: "frontend", // -> probe_success{job="frontend"}
            interval: "30s",
            scrapeTimeout: "10s",
            module: "http_2xx",
            prober: { url: `blackbox-exporter.${MONITORING_NAMESPACE}.svc:9115`, path: "/probe", scheme: "http" },
            targets: {
                staticConfig: {
                    // FQDN: the Probe lives in `monitoring`, the frontend Service in `default`.
                    static: [`http://frontend.${appNamespace}.svc.cluster.local:80/`],
                    labels: { service: "frontend" },
                },
            },
        },
    }, { dependsOn: [kubePrometheusStack, blackboxExporter, ...appDeps] });

    // ---------------------------------------------------------- dashboard (stretch)
    // Single owner: dashboard.ts. (Do not also define a dashboard ConfigMap here.)
    createGuestbookDashboard(appNamespace, MONITORING_NAMESPACE, { dependsOn: [ns] });

    // ------------------------------------------------------------------ outputs
    let grafanaUrl: pulumi.Output<string>;
    if (grafanaServiceType === "NodePort") {
        // Derived from the release, so the URL is only reported once the Helm install succeeded.
        grafanaUrl = kubePrometheusStack.status.apply(() => `http://${grafanaHost}:${grafanaNodePort}`);
    } else {
        // LoadBalancer: read the real address from the chart's Grafana Service instead of guessing.
        // Two-pass, like frontendIp: on a fresh stack the first `pulumi up` can fail this read or
        // see an empty status; run `pulumi up --refresh` once more.
        const grafanaSvc = k8s.core.v1.Service.get(
            "grafana-service",
            pulumi.interpolate`${MONITORING_NAMESPACE}/${KPS_RELEASE}-grafana`,
            { dependsOn: [kubePrometheusStack] },
        );
        grafanaUrl = grafanaSvc.status.apply((s) => {
            const ingress = s?.loadBalancer?.ingress?.[0];
            const host = ingress?.hostname || ingress?.ip;
            return host ? `http://${host}:${GRAFANA_PORT}` : "pending (run `pulumi up --refresh`)";
        });
    }

    return {
        grafanaUrl,
        grafanaAdminUser: pulumi.output("admin"),
        grafanaAdminPassword: pulumi.secret(adminPassword.result),
    };
}
