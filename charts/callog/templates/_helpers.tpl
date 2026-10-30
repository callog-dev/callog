{{/* "<release>-callog", or just "<release>" when it already contains "callog". */}}
{{- define "callog.fullname" -}}
{{- if contains .Chart.Name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{- define "callog.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/* Selector of one component; call with (dict "root" $ "role" "api"). */}}
{{- define "callog.componentSelectorLabels" -}}
{{ include "callog.selectorLabels" .root }}
app.kubernetes.io/component: {{ .role }}
{{- end }}

{{- define "callog.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{ include "callog.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "callog.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "callog.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{- define "callog.secretName" -}}
{{- default (include "callog.fullname" .) .Values.existingSecret }}
{{- end }}

{{- define "callog.image" -}}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) }}
{{- end }}

{{/* The server's GitHub webhook route. */}}
{{- define "callog.webhookPath" -}}/webhooks/github{{- end }}

{{- define "callog.publicUrl" -}}
{{- if .Values.publicUrl }}
{{- .Values.publicUrl }}
{{- else if and .Values.ingress.enabled .Values.ingress.host }}
{{- printf "https://%s" .Values.ingress.host }}
{{- end }}
{{- end }}

{{- define "callog.githubWebhookUrl" -}}
{{- if .Values.githubWebhookUrl }}
{{- .Values.githubWebhookUrl }}
{{- else if and .Values.webhookIngress.enabled .Values.webhookIngress.host }}
{{- printf "https://%s%s" .Values.webhookIngress.host (include "callog.webhookPath" .) }}
{{- end }}
{{- end }}

{{/*
Image, environment and filesystem shared by every container (the image sets PORT and
LOG_FORMAT); call with (dict "root" $ "role" "api").
*/}}
{{- define "callog.containerBase" -}}
image: {{ include "callog.image" .root }}
imagePullPolicy: {{ .root.Values.image.pullPolicy }}
env:
  - name: ROLE
    value: {{ .role }}
  # Migrations run in the worker's init container.
  - name: MIGRATE_ON_START
    value: "false"
  {{- with include "callog.publicUrl" .root }}
  - name: PUBLIC_URL
    value: {{ . | quote }}
  {{- end }}
  {{- with include "callog.githubWebhookUrl" .root }}
  - name: GITHUB_WEBHOOK_URL
    value: {{ . | quote }}
  {{- end }}
  {{- range $name, $value := .root.Values.env }}
  - name: {{ $name }}
    value: {{ $value | quote }}
  {{- end }}
{{- if or .root.Values.existingSecret .root.Values.secretEnv .root.Values.extraEnvFrom }}
envFrom:
  {{- if or .root.Values.existingSecret .root.Values.secretEnv }}
  - secretRef:
      name: {{ include "callog.secretName" .root }}
  {{- end }}
  {{- with .root.Values.extraEnvFrom }}
  {{- toYaml . | nindent 2 }}
  {{- end }}
{{- end }}
securityContext:
  {{- toYaml .root.Values.securityContext | nindent 2 }}
volumeMounts:
  - name: tmp
    mountPath: /tmp
{{- end }}

{{/* The server container without its name; call with (dict "root" $ "role" "api" "spec" .Values.api). */}}
{{- define "callog.container" -}}
{{ include "callog.containerBase" . }}
ports:
  - name: http
    containerPort: 3000
startupProbe:
  # Covers a slow database connection; a failed database check exits the process instead.
  httpGet: { path: /healthz, port: http }
  periodSeconds: 5
  failureThreshold: 60
livenessProbe:
  httpGet: { path: /healthz, port: http }
  periodSeconds: 10
readinessProbe:
  httpGet: { path: /readyz, port: http }
  periodSeconds: 10
  timeoutSeconds: 3
{{- if eq .role "api" }}
lifecycle:
  # Keeps serving while the ingress drops this pod from its endpoints.
  preStop:
    exec:
      command: ["sleep", "10"]
{{- end }}
{{- with .spec.resources }}
resources:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end }}

{{/* Pod template of api or worker; call with (dict "root" $ "role" "api" "spec" .Values.api). */}}
{{- define "callog.podTemplate" -}}
metadata:
  labels:
    {{- include "callog.componentSelectorLabels" . | nindent 4 }}
    {{- with .root.Values.podLabels }}
    {{- toYaml . | nindent 4 }}
    {{- end }}
  {{- $annotations := .root.Values.podAnnotations }}
  {{- if and .root.Values.secretEnv (not .root.Values.existingSecret) }}
  {{- /* Restarts pods when the chart's Secret changes. */}}
  {{- $annotations = merge (dict "checksum/secret" (toJson .root.Values.secretEnv | sha256sum)) $annotations }}
  {{- end }}
  {{- with $annotations }}
  annotations:
    {{- toYaml . | nindent 4 }}
  {{- end }}
spec:
  serviceAccountName: {{ include "callog.serviceAccountName" .root }}
  automountServiceAccountToken: false
  {{- with .root.Values.imagePullSecrets }}
  imagePullSecrets:
    {{- toYaml . | nindent 4 }}
  {{- end }}
  {{- with .root.Values.priorityClassName }}
  priorityClassName: {{ . }}
  {{- end }}
  terminationGracePeriodSeconds: {{ .root.Values.terminationGracePeriodSeconds }}
  securityContext:
    {{- toYaml .root.Values.podSecurityContext | nindent 4 }}
  {{- with .spec.nodeSelector }}
  nodeSelector:
    {{- toYaml . | nindent 4 }}
  {{- end }}
  {{- with .spec.tolerations }}
  tolerations:
    {{- toYaml . | nindent 4 }}
  {{- end }}
  {{- with .spec.affinity }}
  affinity:
    {{- toYaml . | nindent 4 }}
  {{- end }}
  volumes:
    - name: tmp
      emptyDir: {}
  {{- if and (eq .role "worker") .root.Values.migrations.enabled }}
  initContainers:
    - name: migrate
      command: ["node", "dist/db/migrate.cli.js"]
      {{- include "callog.containerBase" . | nindent 6 }}
      {{- with .root.Values.migrations.resources }}
      resources:
        {{- toYaml . | nindent 8 }}
      {{- end }}
  {{- end }}
  containers:
    - name: {{ .role }}
      {{- include "callog.container" . | nindent 6 }}
{{- end }}

{{/* One Ingress; call with (dict "root" $ "values" .Values.ingress "name" "..." "path" "/" "pathType" "Prefix"). */}}
{{- define "callog.ingress" -}}
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: {{ .name }}
  labels:
    {{- include "callog.labels" .root | nindent 4 }}
  {{- with .values.annotations }}
  annotations:
    {{- toYaml . | nindent 4 }}
  {{- end }}
spec:
  {{- with .values.className }}
  ingressClassName: {{ . }}
  {{- end }}
  {{- with .values.tls }}
  tls:
    {{- toYaml . | nindent 4 }}
  {{- end }}
  rules:
    - host: {{ required "host is required for an enabled ingress" .values.host | quote }}
      http:
        paths:
          - path: {{ .path }}
            pathType: {{ .pathType }}
            backend:
              service:
                name: {{ include "callog.fullname" .root }}-api
                port:
                  name: http
{{- end }}
