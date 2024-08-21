import * as digitalocean from "@pulumi/digitalocean";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

let config = new pulumi.Config();

const doCluster = new digitalocean.KubernetesCluster("do-cluster", {
    region: "nyc3",
    version: "1.29.6-do.0",
    nodePool: {
        name: "default",
        size: "s-4vcpu-8gb",
        nodeCount: 2,
    },
});

export const kubeconfig = doCluster.kubeConfigs[0].rawConfig;

const k8sProvider = new k8s.Provider("do-k8s", {
    kubeconfig: doCluster.kubeConfigs[0].rawConfig,
});

const ingressNginxHelmRelease = new k8s.helm.v3.Release("ingress-nginx", {
    name: "ingress-nginx",
    chart: "ingress-nginx",
    repositoryOpts: {
        repo: "https://kubernetes.github.io/ingress-nginx",
    },
    namespace: "ingress-nginx",
    version: "4.11.2",
    createNamespace: true,
    values: {
        serviceAccount: {
            automountServiceAccountToken: true,
        },
        controller: {
            allowSnippetAnnotations: false,
        },
    },
}, {provider: k8sProvider, ignoreChanges: ["version"]});


const srv = k8s.core.v1.Service.get("ingress-nginx-controller-svc", pulumi.interpolate`${ingressNginxHelmRelease.status.namespace}/ingress-nginx-controller`, {provider: k8sProvider});

export const ingressSvcLBIp = srv.status.loadBalancer.ingress[0].ip;

const argoHelmRelease = new k8s.helm.v3.Release("argo", {
    name: "argocd",
    chart: "argo-cd",
    repositoryOpts: {
        repo: "https://argoproj.github.io/argo-helm",
    },
    namespace: "argocd",
    createNamespace: true,
    version: "7.4.4",
    values: {
        configs: {
            params: {
                "server\.insecure": true,
            },
            cm: {
                "accounts\.port": "apiKey",
            },
            rbac: {
                "policy\.csv": `p, role:read-only-role, applications, *, */*, allow
p, role:read-only-role, clusters, get, *, allow
p, role:read-only-role, repositories, get, *, allow
p, role:read-only-role, projects, get, *, allow
p, role:read-only-role, logs, get, *, allow

g, port, role:read-only-role
`
            },
        },
        server: {
            ingress: {
                enabled: true,
                ingressClassName: "nginx",
                hostname: pulumi.interpolate`argocd.${ingressSvcLBIp}.nip.io`

            },
        },
    },
}, {provider: k8sProvider, ignoreChanges: ["version"]});

export const argoLBIp = pulumi.interpolate`argocd.${ingressSvcLBIp}.nip.io`;

const portOceanArgoCD = new k8s.apiextensions.CustomResource("argo-cd-port-ocean", {
    apiVersion: "argoproj.io/v1alpha1",
    kind: "Application",
    metadata: {
        name: "port-ocean",
        namespace: argoHelmRelease.status.namespace,
    },
    spec: {
        destination: {
            namespace: "port-ocean",
            server: "https://kubernetes.default.svc",
        },
        project: "default",
        sources: [
            {
                repoURL: "https://github.com/my-silly-organisation/port-quickstart",
                targetRevision: "main",
                path: "gitops",
                directory: {
                    recurse: true,
                    exclude: '{*values.yaml,workload/*,*/my-ocean*/*}',
                }
            },
            {
                repoURL: "https://port-labs.github.io/helm-charts/",
                chart: "port-k8s-exporter",
                targetRevision: "0.2.33",
                helm: {
                    valueFiles: ["$values/gitops/k8s-exporter/my-ocean-k8s-integration/values.yaml"],
                    parameters: [
                        {
                            name: "secret.secrets.portClientId",
                            value: config.requireSecret("clientId"),
                        },
                        {
                            name: "secret.secrets.portClientSecret",
                            value: config.requireSecret("clientSecret"),
                        }
                    ],
                }
            },
            {
                repoURL: "https://port-labs.github.io/helm-charts/",
                chart: "port-ocean",
                targetRevision: "0.1.18",
                helm: {
                    valueFiles: ["$values/gitops/argocd/my-ocean-argocd-integration/values.yaml"],
                    parameters: [
                        {
                            name: "port.clientId",
                            value: config.requireSecret("clientId"),
                        },
                        {
                            name: "port.clientSecret",
                            value: config.requireSecret("clientSecret"),
                        },
                        {
                            name: "port.baseUrl",
                            value: "https://api.getport.io",
                        },
                        {
                            name: "integration.config.serverUrl",
                            value: pulumi.interpolate`http://argocd.${ingressSvcLBIp}.nip.io`,
                        },
                        {
                            name: "integration.secrets.token",
                            value: config.requireSecret("token"),
                        }
                    ],
                },
            },
            {
                repoURL: "https://github.com/my-silly-organisation/port-quickstart",
                targetRevision: "main",
                ref: "values",
            },
        ],
        syncPolicy: {
            automated: {
                prune: true,
                selfHeal: true,
            },
            syncOptions: ["CreateNamespace=true"],
        },
    },
}, {provider: k8sProvider});
