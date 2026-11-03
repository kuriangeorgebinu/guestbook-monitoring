/**
 * dashboard.ts - the Guestbook Grafana dashboard (stretch goal), delivered as a ConfigMap that the
 * kube-prometheus-stack Grafana dashboard sidecar picks up. Requirements of that sidecar:
 *   - namespace "monitoring" (its searchNamespace in monitoring.ts),
 *   - label grafana_dashboard: "1",
 *   - a data key ending in .json.
 * Panels select by job / namespace / container, never pod-name prefixes (those are generated).
 */

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

// Same pattern as the chart's own dashboards: resolve Prometheus through a template variable.
const DATASOURCE = { type: "prometheus", uid: "${datasource}" };

interface GridPos { h: number; w: number; x: number; y: number }

function timeseries(id: number, title: string, expr: string, unit: string, gridPos: GridPos, legendFormat: string) {
    return {
        id, type: "timeseries", title, datasource: DATASOURCE, gridPos,
        fieldConfig: { defaults: { unit, custom: { lineWidth: 2, fillOpacity: 8, showPoints: "never" } }, overrides: [] },
        options: { legend: { displayMode: "list", placement: "bottom", showLegend: true }, tooltip: { mode: "multi", sort: "none" } },
        targets: [{ refId: "A", expr, datasource: DATASOURCE, editorMode: "code", range: true, legendFormat }],
    };
}

export function guestbookDashboard(appNamespace: string): object {
    // Pod-level cAdvisor series (container=""), grouped into a "workload" label taken from the pod
    // name. Docker Desktop's runtime (cri-dockerd) exposes ONLY pod-level series, with no
    // `container` label, so per-container selectors return nothing there; pod-level series exist
    // on every runtime, so this works everywhere. Per-pod figures include the redis-exporter sidecar.
    const workloads = "(frontend|redis-leader|redis-replica)-.+";
    const podLevel = `namespace="${appNamespace}", container="", pod=~"${workloads}"`;
    const byWorkload = (expr: string) => `sum by (workload) (label_replace(${expr}, "workload", "$1", "pod", "${workloads}"))`;
    return {
        uid: "guestbook",
        title: "Guestbook",
        tags: ["guestbook"],
        timezone: "browser",
        schemaVersion: 39,
        version: 1,
        refresh: "30s",
        time: { from: "now-30m", to: "now" },
        templating: {
            list: [{
                name: "datasource", label: "Data source", type: "datasource", query: "prometheus",
                current: {}, hide: 0, refresh: 1, regex: "", skipUrlSync: false, multi: false, includeAll: false, options: [],
            }],
        },
        panels: [
            {
                id: 1, type: "stat", title: "Frontend probe (1 = UP)", datasource: DATASOURCE,
                gridPos: { h: 6, w: 6, x: 0, y: 0 },
                fieldConfig: {
                    defaults: {
                        unit: "short", color: { mode: "thresholds" },
                        thresholds: { mode: "absolute", steps: [{ color: "red", value: null }, { color: "green", value: 1 }] },
                    },
                    overrides: [],
                },
                options: { reduceOptions: { calcs: ["lastNotNull"], fields: "", values: false }, colorMode: "background", graphMode: "none", textMode: "value" },
                targets: [{ refId: "A", expr: 'probe_success{job="frontend"}', datasource: DATASOURCE, instant: true, range: false, editorMode: "code" }],
            },
            timeseries(2, "Frontend probe latency", 'probe_duration_seconds{job="frontend"}', "s", { h: 6, w: 9, x: 6, y: 0 }, "{{instance}}"),
            timeseries(3, "Redis commands/sec", "sum by (job) (rate(redis_commands_processed_total[5m]))", "ops", { h: 6, w: 9, x: 15, y: 0 }, "{{job}}"),
            timeseries(4, "Redis connected clients", "sum by (job) (redis_connected_clients)", "short", { h: 7, w: 12, x: 0, y: 6 }, "{{job}}"),
            timeseries(5, "Guestbook CPU usage by workload (cores)", byWorkload(`rate(container_cpu_usage_seconds_total{${podLevel}}[5m])`), "cores", { h: 7, w: 12, x: 12, y: 6 }, "{{workload}}"),
            timeseries(6, "Guestbook memory working set by workload", byWorkload(`container_memory_working_set_bytes{${podLevel}}`), "bytes", { h: 7, w: 24, x: 0, y: 13 }, "{{workload}}"),
        ],
    };
}

/**
 * @param monitoringNamespace must equal the Grafana sidecar's searchNamespace (passed in from
 *        monitoring.ts so there is one source of truth; a mismatch is silently ignored by the sidecar).
 */
export function createGuestbookDashboard(
    appNamespace: string,
    monitoringNamespace: string,
    opts?: pulumi.CustomResourceOptions,
): k8s.core.v1.ConfigMap {
    return new k8s.core.v1.ConfigMap("guestbook-dashboard", {
        metadata: {
            name: "guestbook-dashboard",
            namespace: monitoringNamespace,
            labels: { grafana_dashboard: "1" },
            annotations: { grafana_folder: "Guestbook" },
        },
        data: { "guestbook.json": JSON.stringify(guestbookDashboard(appNamespace), null, 2) },
    }, opts);
}
