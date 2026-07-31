use std::collections::{HashMap, HashSet};

use async_trait::async_trait;
use serde_json::Value;

use crate::connection::AppState;

use super::service::{docker_remove_network_core, docker_rename_container_core, validate_create_container_request};
use super::{
    docker_container_action_core, docker_create_container_core, docker_create_network_core,
    docker_list_containers_core, docker_list_networks_core, docker_remove_container_core, DockerComposeApplyRequest,
    DockerComposeApplyResult, DockerContainer, DockerContainerAction, DockerCreateContainerRequest,
    DockerCreateContainerResult, DockerCreateNetworkRequest, DockerCreateNetworkResult, DockerMountInput,
    DockerNetwork, DockerPortBinding,
};

#[derive(Debug)]
struct ComposeServicePlan {
    service_name: String,
    request: DockerCreateContainerRequest,
}

#[derive(Debug, Clone)]
struct ExistingContainerBackup {
    id: String,
    original_name: String,
    backup_name: String,
    original_state: String,
}

#[derive(Debug)]
struct CreatedNetwork {
    id: String,
    name: String,
}

#[derive(Debug, Default)]
struct ComposeMutationJournal {
    created_container_ids: Vec<String>,
    created_networks: Vec<CreatedNetwork>,
    backups: Vec<ExistingContainerBackup>,
}

#[async_trait]
trait ComposeRuntime {
    async fn list_containers(&self) -> Result<Vec<DockerContainer>, String>;
    async fn list_networks(&self) -> Result<Vec<DockerNetwork>, String>;
    async fn create_network(&self, request: DockerCreateNetworkRequest) -> Result<DockerCreateNetworkResult, String>;
    async fn remove_network(&self, network_id: &str) -> Result<(), String>;
    async fn rename_container(&self, container_id: &str, name: &str) -> Result<(), String>;
    async fn container_action(&self, container_id: &str, action: DockerContainerAction) -> Result<(), String>;
    async fn create_container(
        &self,
        request: DockerCreateContainerRequest,
    ) -> Result<DockerCreateContainerResult, String>;
    async fn remove_container(&self, container_id: &str) -> Result<(), String>;
}

struct CoreComposeRuntime<'a> {
    state: &'a AppState,
    connection_id: &'a str,
}

#[async_trait]
impl ComposeRuntime for CoreComposeRuntime<'_> {
    async fn list_containers(&self) -> Result<Vec<DockerContainer>, String> {
        docker_list_containers_core(self.state, self.connection_id, true).await
    }

    async fn list_networks(&self) -> Result<Vec<DockerNetwork>, String> {
        docker_list_networks_core(self.state, self.connection_id).await
    }

    async fn create_network(&self, request: DockerCreateNetworkRequest) -> Result<DockerCreateNetworkResult, String> {
        docker_create_network_core(self.state, self.connection_id, request).await
    }

    async fn remove_network(&self, network_id: &str) -> Result<(), String> {
        docker_remove_network_core(self.state, self.connection_id, network_id).await
    }

    async fn rename_container(&self, container_id: &str, name: &str) -> Result<(), String> {
        docker_rename_container_core(self.state, self.connection_id, container_id, name).await
    }

    async fn container_action(&self, container_id: &str, action: DockerContainerAction) -> Result<(), String> {
        docker_container_action_core(self.state, self.connection_id, container_id, action).await
    }

    async fn create_container(
        &self,
        request: DockerCreateContainerRequest,
    ) -> Result<DockerCreateContainerResult, String> {
        docker_create_container_core(self.state, self.connection_id, request).await
    }

    async fn remove_container(&self, container_id: &str) -> Result<(), String> {
        docker_remove_container_core(self.state, self.connection_id, container_id).await
    }
}

pub async fn docker_apply_compose_core(
    state: &AppState,
    connection_id: &str,
    request: DockerComposeApplyRequest,
) -> Result<DockerComposeApplyResult, String> {
    apply_compose_with_runtime(&CoreComposeRuntime { state, connection_id }, request).await
}

async fn apply_compose_with_runtime(
    runtime: &impl ComposeRuntime,
    request: DockerComposeApplyRequest,
) -> Result<DockerComposeApplyResult, String> {
    let project = validate_project_name(&request.project_name)?;
    let plan = build_compose_plan(&project, &request.content)?;
    let all_containers = runtime.list_containers().await?;
    let planned_names = plan.iter().map(|service| service.request.name.as_str()).collect::<HashSet<_>>();
    let mut existing_project = Vec::new();
    for container in all_containers {
        if container.labels.get("com.docker.compose.project") == Some(&project) {
            existing_project.push(container);
        } else if container
            .names
            .iter()
            .map(|name| name.trim_start_matches('/'))
            .any(|name| planned_names.contains(name))
        {
            return Err(format!(
                "Compose container name conflicts with an existing container outside project {project}"
            ));
        }
    }
    if !request.replace_existing && !existing_project.is_empty() {
        return Err(format!("Compose project {project} already exists; enable replacement to update it"));
    }
    let backup_plan = if request.replace_existing {
        existing_project
            .iter()
            .map(|container| {
                Ok(ExistingContainerBackup {
                    id: container.id.clone(),
                    original_name: primary_container_name(container)?,
                    backup_name: format!("dbx-backup-{project}-{}", short_container_id(&container.id)),
                    original_state: container.state.clone(),
                })
            })
            .collect::<Result<Vec<_>, String>>()?
    } else {
        Vec::new()
    };

    let existing_networks = runtime.list_networks().await?;
    let mut network_names = existing_networks.into_iter().map(|network| network.name).collect::<HashSet<_>>();
    let mut requested_networks = plan.iter().filter_map(|service| service.request.network.clone()).collect::<Vec<_>>();
    requested_networks.sort();
    requested_networks.dedup();
    let mut journal = ComposeMutationJournal::default();
    for network in requested_networks {
        if network_names.insert(network.clone()) {
            match runtime
                .create_network(DockerCreateNetworkRequest {
                    name: network.clone(),
                    driver: "bridge".to_string(),
                    internal: false,
                    attachable: false,
                    subnet: None,
                    gateway: None,
                })
                .await
            {
                Ok(result) => journal.created_networks.push(CreatedNetwork {
                    id: if result.id.is_empty() { network.clone() } else { result.id },
                    name: network,
                }),
                Err(error) => {
                    let rollback = remove_created_networks(runtime, &journal.created_networks).await;
                    return Err(with_rollback(
                        format!("Failed to create Compose network {network}: {error}"),
                        false,
                        !backup_plan.is_empty(),
                        rollback,
                    ));
                }
            }
        }
    }

    if request.replace_existing {
        for backup in &backup_plan {
            if let Err(error) = runtime.rename_container(&backup.id, &backup.backup_name).await {
                let rollback = rollback_replacement(runtime, &journal).await;
                return Err(with_rollback(
                    format!("Failed to stage existing Compose container {}: {error}", backup.original_name),
                    !journal.backups.is_empty(),
                    !backup_plan.is_empty(),
                    rollback,
                ));
            }
            journal.backups.push(backup.clone());
        }

        for backup in &journal.backups {
            let result = async {
                if backup.original_state.eq_ignore_ascii_case("paused") {
                    runtime.container_action(&backup.id, DockerContainerAction::Unpause).await?;
                }
                if backup.original_state.eq_ignore_ascii_case("running")
                    || backup.original_state.eq_ignore_ascii_case("paused")
                {
                    runtime.container_action(&backup.id, DockerContainerAction::Stop).await?;
                }
                Ok::<(), String>(())
            }
            .await;
            if let Err(error) = result {
                let rollback = rollback_replacement(runtime, &journal).await;
                return Err(with_rollback(
                    format!("Failed to stop staged Compose container {}: {error}", backup.original_name),
                    true,
                    true,
                    rollback,
                ));
            }
        }
    }

    let mut warnings = Vec::new();
    for service in &plan {
        match runtime.create_container(service.request.clone()).await {
            Ok(result) => {
                journal.created_container_ids.push(result.id);
                warnings.extend(result.warnings);
            }
            Err(error) => {
                let rollback = rollback_replacement(runtime, &journal).await;
                return Err(with_rollback(
                    format!("Failed to create Compose service {}: {error}", service.service_name),
                    !journal.backups.is_empty(),
                    !backup_plan.is_empty(),
                    rollback,
                ));
            }
        }
    }
    for (index, container_id) in journal.created_container_ids.iter().enumerate() {
        if let Err(error) = runtime.container_action(container_id, DockerContainerAction::Start).await {
            let rollback = rollback_replacement(runtime, &journal).await;
            return Err(with_rollback(
                format!("Failed to start Compose service {}: {error}", plan[index].service_name),
                !journal.backups.is_empty(),
                !backup_plan.is_empty(),
                rollback,
            ));
        }
    }
    if plan.len() > 1 {
        warnings.push(
            "Services are created in document order; depends_on health conditions are not evaluated.".to_string(),
        );
    }

    for backup in &journal.backups {
        if let Err(error) = runtime.remove_container(&backup.id).await {
            warnings.push(format!(
                "Replacement succeeded, but stopped backup container {} ({}) could not be removed: {error}",
                backup.backup_name, backup.id
            ));
        }
    }

    Ok(DockerComposeApplyResult { container_ids: journal.created_container_ids, warnings })
}

fn build_compose_plan(project: &str, content: &str) -> Result<Vec<ComposeServicePlan>, String> {
    let document: Value = serde_yaml_ng::from_str(content).map_err(|error| format!("Invalid Compose YAML: {error}"))?;
    let services =
        document.get("services").and_then(Value::as_object).ok_or("Compose document must contain a services object")?;
    if services.is_empty() {
        return Err("Compose document must define at least one service".to_string());
    }

    let mut names = HashSet::new();
    let mut plan = Vec::with_capacity(services.len());
    for (service_name, service) in services {
        let service = service.as_object().ok_or_else(|| format!("Service {service_name} must be an object"))?;
        let image = required_string(service.get("image"), &format!("Service {service_name} image"))?;
        let container_name =
            optional_string(service.get("container_name"), &format!("Service {service_name} container_name"))?
                .unwrap_or_else(|| format!("{project}-{service_name}-1"));
        if !names.insert(container_name.clone()) {
            return Err(format!("Compose container name {container_name} is defined more than once"));
        }
        let requested_network =
            first_network(service.get("networks"), service_name)?.unwrap_or_else(|| "default".to_string());
        let network = if requested_network == "host" || requested_network == "none" {
            None
        } else {
            Some(format!("{project}_{requested_network}"))
        };
        let mut labels = string_map(service.get("labels"), &format!("Service {service_name} labels"))?;
        labels.insert("com.docker.compose.project".to_string(), project.to_string());
        labels.insert("com.docker.compose.service".to_string(), service_name.clone());
        labels.insert("com.docker.compose.container-number".to_string(), "1".to_string());
        labels.insert("com.docker.compose.oneoff".to_string(), "False".to_string());
        let request = DockerCreateContainerRequest {
            name: container_name,
            image,
            command: string_list(service.get("command"), &format!("Service {service_name} command"))?,
            environment: environment_list(service.get("environment"), service_name)?,
            ports: value_array(service.get("ports"), &format!("Service {service_name} ports"))?
                .map(|values| values.iter().map(parse_port).collect::<Result<Vec<_>, _>>())
                .transpose()?
                .unwrap_or_default(),
            mounts: value_array(service.get("volumes"), &format!("Service {service_name} volumes"))?
                .map(|values| values.iter().map(|value| parse_mount(value, project)).collect::<Result<Vec<_>, _>>())
                .transpose()?
                .unwrap_or_default(),
            labels,
            network,
            restart_policy: optional_string(service.get("restart"), &format!("Service {service_name} restart"))?
                .as_deref()
                .unwrap_or("no")
                .split(':')
                .next()
                .unwrap_or("no")
                .to_string(),
            start: false,
        };
        validate_create_container_request(&request)
            .map_err(|error| format!("Invalid Compose service {service_name}: {error}"))?;
        plan.push(ComposeServicePlan { service_name: service_name.clone(), request });
    }
    Ok(plan)
}

async fn rollback_replacement(runtime: &impl ComposeRuntime, journal: &ComposeMutationJournal) -> Vec<String> {
    let mut errors = Vec::new();
    for container_id in journal.created_container_ids.iter().rev() {
        let _ = runtime.container_action(container_id, DockerContainerAction::Stop).await;
        if let Err(error) = runtime.remove_container(container_id).await {
            errors.push(format!("could not remove replacement container {container_id}: {error}"));
        }
    }
    errors.extend(remove_created_networks(runtime, &journal.created_networks).await);
    for backup in journal.backups.iter().rev() {
        if let Err(error) = runtime.rename_container(&backup.id, &backup.original_name).await {
            errors.push(format!(
                "could not restore container name {} from {}: {error}",
                backup.original_name, backup.backup_name
            ));
        }
        let restore = async {
            if backup.original_state.eq_ignore_ascii_case("running")
                || backup.original_state.eq_ignore_ascii_case("paused")
            {
                runtime.container_action(&backup.id, DockerContainerAction::Start).await?;
            }
            if backup.original_state.eq_ignore_ascii_case("paused") {
                runtime.container_action(&backup.id, DockerContainerAction::Pause).await?;
            }
            Ok::<(), String>(())
        }
        .await;
        if let Err(error) = restore {
            errors.push(format!("could not restore container {} state: {error}", backup.original_name));
        }
    }
    errors
}

async fn remove_created_networks(runtime: &impl ComposeRuntime, networks: &[CreatedNetwork]) -> Vec<String> {
    let mut errors = Vec::new();
    for network in networks.iter().rev() {
        if let Err(error) = runtime.remove_network(&network.id).await {
            errors.push(format!("could not remove created network {}: {error}", network.name));
        }
    }
    errors
}

fn primary_container_name(container: &DockerContainer) -> Result<String, String> {
    container
        .names
        .iter()
        .map(|name| name.trim_start_matches('/'))
        .find(|name| !name.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("Existing Compose container {} has no restorable name", container.id))
}

fn short_container_id(id: &str) -> &str {
    id.trim_start_matches("sha256:").get(..12).unwrap_or(id.trim_start_matches("sha256:"))
}

fn with_rollback(error: String, previous_touched: bool, had_previous: bool, rollback_errors: Vec<String>) -> String {
    if !rollback_errors.is_empty() {
        format!("{error}; rollback encountered: {}", rollback_errors.join("; "))
    } else if previous_touched {
        format!("{error}; previous Compose deployment was restored")
    } else if had_previous {
        format!("{error}; previous Compose deployment was left unchanged")
    } else {
        format!("{error}; replacement resources were cleaned up")
    }
}

fn validate_project_name(value: &str) -> Result<String, String> {
    let value = value.trim().to_ascii_lowercase();
    if value.is_empty()
        || value.len() > 63
        || !value.chars().all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("Compose project name must contain only letters, numbers, hyphens, or underscores".to_string());
    }
    Ok(value)
}

fn required_string(value: Option<&Value>, field: &str) -> Result<String, String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("{field} is required"))
}

fn optional_string(value: Option<&Value>, field: &str) -> Result<Option<String>, String> {
    match value {
        None => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(_) => Err(format!("{field} must be a string")),
    }
}

fn value_array<'a>(value: Option<&'a Value>, field: &str) -> Result<Option<&'a Vec<Value>>, String> {
    match value {
        None => Ok(None),
        Some(Value::Array(values)) => Ok(Some(values)),
        Some(_) => Err(format!("{field} must be an array")),
    }
}

fn string_list(value: Option<&Value>, field: &str) -> Result<Vec<String>, String> {
    match value {
        None => Ok(Vec::new()),
        Some(Value::Array(values)) => values
            .iter()
            .map(|value| value_string(value).ok_or_else(|| format!("{field} entries must be scalar values")))
            .collect(),
        Some(Value::String(value)) => Ok(value.split_whitespace().map(str::to_string).collect()),
        Some(_) => Err(format!("{field} must be a string or array")),
    }
}

fn environment_list(value: Option<&Value>, service_name: &str) -> Result<Vec<String>, String> {
    let field = format!("Service {service_name} environment");
    match value {
        None => Ok(Vec::new()),
        Some(Value::Array(values)) => values
            .iter()
            .map(|value| value_string(value).ok_or_else(|| format!("{field} entries must be scalar values")))
            .collect(),
        Some(Value::Object(values)) => values
            .iter()
            .map(|(key, value)| {
                value_string(value)
                    .map(|value| format!("{key}={value}"))
                    .ok_or_else(|| format!("{field} values must be scalar"))
            })
            .collect(),
        Some(_) => Err(format!("{field} must be an array or object")),
    }
}

fn string_map(value: Option<&Value>, field: &str) -> Result<HashMap<String, String>, String> {
    match value {
        None => Ok(HashMap::new()),
        Some(Value::Object(values)) => values
            .iter()
            .map(|(key, value)| {
                value_string(value)
                    .map(|value| (key.clone(), value))
                    .ok_or_else(|| format!("{field} values must be scalar"))
            })
            .collect(),
        Some(Value::Array(values)) => values
            .iter()
            .map(|value| {
                let value = value_string(value).ok_or_else(|| format!("{field} entries must be strings"))?;
                value
                    .split_once('=')
                    .map(|(key, value)| (key.to_string(), value.to_string()))
                    .ok_or_else(|| format!("{field} entries must use key=value syntax"))
            })
            .collect(),
        Some(_) => Err(format!("{field} must be an array or object")),
    }
}

fn value_string(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        Value::Bool(value) => Some(value.to_string()),
        Value::Null => Some(String::new()),
        _ => None,
    }
}

fn first_network(value: Option<&Value>, service_name: &str) -> Result<Option<String>, String> {
    match value {
        None => Ok(None),
        Some(Value::Array(values)) => values
            .first()
            .map(|value| {
                value_string(value).ok_or_else(|| format!("Service {service_name} networks entries must be strings"))
            })
            .transpose(),
        Some(Value::Object(values)) => Ok(values.keys().next().cloned()),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(_) => Err(format!("Service {service_name} networks must be a string, array, or object")),
    }
}

fn parse_port(value: &Value) -> Result<DockerPortBinding, String> {
    let text = value_string(value).ok_or("Compose ports must use short string syntax")?;
    let (mapping, protocol) = text.rsplit_once('/').map_or((text.as_str(), "tcp"), |parts| parts);
    let mut parts = mapping.rsplitn(3, ':');
    let container_port = parts
        .next()
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or_else(|| format!("Invalid Compose port mapping: {text}"))?;
    let host_port = parts.next().and_then(|value| value.parse::<u16>().ok());
    let host_ip = parts.next().unwrap_or_default().to_string();
    Ok(DockerPortBinding { container_port, protocol: protocol.to_string(), host_ip, host_port })
}

fn parse_mount(value: &Value, project: &str) -> Result<DockerMountInput, String> {
    let text = value_string(value).ok_or("Compose volumes must use short string syntax")?;
    let mut parts = text.rsplitn(3, ':');
    let mode_or_target = parts.next().unwrap_or_default();
    let (target, read_only) = if matches!(mode_or_target, "ro" | "rw") {
        (parts.next().unwrap_or_default(), mode_or_target == "ro")
    } else {
        (mode_or_target, false)
    };
    let source = parts.next().ok_or_else(|| format!("Invalid Compose volume mapping: {text}"))?;
    let is_bind = source.starts_with('/') || source.starts_with('.') || source.as_bytes().get(1) == Some(&b':');
    Ok(DockerMountInput {
        mount_type: if is_bind { "bind" } else { "volume" }.to_string(),
        source: if is_bind { source.to_string() } else { format!("{project}_{source}") },
        target: target.to_string(),
        read_only,
    })
}

#[cfg(test)]
mod tests {
    use std::{
        collections::HashMap,
        sync::{Arc, Mutex},
    };

    use async_trait::async_trait;

    use super::{apply_compose_with_runtime, build_compose_plan, with_rollback, ComposeRuntime};
    use crate::docker::{
        DockerComposeApplyRequest, DockerContainer, DockerContainerAction, DockerCreateContainerRequest,
        DockerCreateContainerResult, DockerCreateNetworkRequest, DockerCreateNetworkResult, DockerNetwork,
    };

    #[derive(Debug, Default)]
    struct FakeState {
        operations: Vec<String>,
        create_count: usize,
        fail_create_at: Option<usize>,
        fail_start_new: bool,
        fail_backup_rename: bool,
        fail_restore_rename: bool,
    }

    #[derive(Clone)]
    struct FakeRuntime {
        containers: Vec<DockerContainer>,
        networks: Vec<DockerNetwork>,
        state: Arc<Mutex<FakeState>>,
    }

    impl FakeRuntime {
        fn replacement(state: FakeState) -> Self {
            let mut labels = HashMap::new();
            labels.insert("com.docker.compose.project".to_string(), "demo".to_string());
            Self {
                containers: vec![DockerContainer {
                    id: "old-api".to_string(),
                    names: vec!["/demo-api-1".to_string()],
                    image: "example/api:old".to_string(),
                    image_id: "sha256:old".to_string(),
                    command: String::new(),
                    created: 0,
                    state: "running".to_string(),
                    status: "Up".to_string(),
                    ports: Vec::new(),
                    labels,
                    network_ips: HashMap::new(),
                }],
                networks: Vec::new(),
                state: Arc::new(Mutex::new(state)),
            }
        }

        fn operations(&self) -> Vec<String> {
            self.state.lock().expect("fake state").operations.clone()
        }
    }

    #[async_trait]
    impl ComposeRuntime for FakeRuntime {
        async fn list_containers(&self) -> Result<Vec<DockerContainer>, String> {
            Ok(self.containers.clone())
        }

        async fn list_networks(&self) -> Result<Vec<DockerNetwork>, String> {
            Ok(self.networks.clone())
        }

        async fn create_network(
            &self,
            request: DockerCreateNetworkRequest,
        ) -> Result<DockerCreateNetworkResult, String> {
            self.state.lock().expect("fake state").operations.push(format!("create-network:{}", request.name));
            Ok(DockerCreateNetworkResult { id: format!("network-{}", request.name), warning: String::new() })
        }

        async fn remove_network(&self, network_id: &str) -> Result<(), String> {
            self.state.lock().expect("fake state").operations.push(format!("remove-network:{network_id}"));
            Ok(())
        }

        async fn rename_container(&self, container_id: &str, name: &str) -> Result<(), String> {
            let mut state = self.state.lock().expect("fake state");
            state.operations.push(format!("rename:{container_id}:{name}"));
            if state.fail_backup_rename && name.starts_with("dbx-backup-") {
                return Err("backup rename failed".to_string());
            }
            if state.fail_restore_rename && name == "demo-api-1" {
                return Err("restore rename failed".to_string());
            }
            Ok(())
        }

        async fn container_action(&self, container_id: &str, action: DockerContainerAction) -> Result<(), String> {
            let mut state = self.state.lock().expect("fake state");
            state.operations.push(format!("action:{container_id}:{action:?}"));
            if state.fail_start_new
                && container_id.starts_with("new-")
                && matches!(action, DockerContainerAction::Start)
            {
                state.fail_start_new = false;
                return Err("replacement start failed".to_string());
            }
            Ok(())
        }

        async fn create_container(
            &self,
            _request: DockerCreateContainerRequest,
        ) -> Result<DockerCreateContainerResult, String> {
            let mut state = self.state.lock().expect("fake state");
            state.create_count += 1;
            let create_count = state.create_count;
            state.operations.push(format!("create-container:{create_count}"));
            if state.fail_create_at == Some(create_count) {
                return Err("replacement create failed".to_string());
            }
            Ok(DockerCreateContainerResult { id: format!("new-{create_count}"), warnings: Vec::new() })
        }

        async fn remove_container(&self, container_id: &str) -> Result<(), String> {
            self.state.lock().expect("fake state").operations.push(format!("remove-container:{container_id}"));
            Ok(())
        }
    }

    fn replacement_request() -> DockerComposeApplyRequest {
        DockerComposeApplyRequest {
            project_name: "demo".to_string(),
            content: r#"
services:
  api:
    image: example/api:new
  worker:
    image: example/worker:new
"#
            .to_string(),
            replace_existing: true,
        }
    }

    #[test]
    fn validates_every_service_before_returning_an_execution_plan() {
        let error = build_compose_plan(
            "demo",
            r#"
services:
  valid:
    image: nginx:latest
  invalid:
    image: busybox:latest
    ports:
      - "not-a-port"
"#,
        )
        .expect_err("a later invalid service must reject the complete plan");

        assert!(error.contains("Invalid Compose port mapping"), "{error}");
    }

    #[test]
    fn creates_stopped_requests_for_two_phase_startup() {
        let plan = build_compose_plan(
            "demo",
            r#"
services:
  api:
    image: example/api:latest
    networks:
      - backend
  worker:
    image: example/worker:latest
"#,
        )
        .expect("compose plan");

        assert_eq!(plan.len(), 2);
        assert!(plan.iter().all(|service| !service.request.start));
        assert_eq!(plan[0].request.network.as_deref(), Some("demo_backend"));
        assert_eq!(plan[1].request.network.as_deref(), Some("demo_default"));
    }

    #[test]
    fn rejects_duplicate_container_names_before_replacement() {
        let error = build_compose_plan(
            "demo",
            r#"
services:
  api:
    image: example/api:latest
    container_name: shared-name
  worker:
    image: example/worker:latest
    container_name: shared-name
"#,
        )
        .expect_err("duplicate names must not reach execution");

        assert!(error.contains("defined more than once"), "{error}");
    }

    #[test]
    fn reports_clean_and_partial_rollbacks_differently() {
        assert!(with_rollback("create failed".to_string(), true, true, Vec::new()).contains("was restored"));
        assert!(with_rollback("create failed".to_string(), true, true, vec!["rename failed".to_string()])
            .contains("rollback encountered: rename failed"));
    }

    #[tokio::test]
    async fn restores_previous_deployment_when_a_later_create_fails() {
        let runtime = FakeRuntime::replacement(FakeState { fail_create_at: Some(2), ..FakeState::default() });
        let error =
            apply_compose_with_runtime(&runtime, replacement_request()).await.expect_err("second create must fail");

        assert!(error.contains("previous Compose deployment was restored"), "{error}");
        let operations = runtime.operations();
        assert!(operations.iter().any(|operation| operation == "remove-container:new-1"), "{operations:?}");
        assert!(operations.iter().any(|operation| operation == "rename:old-api:demo-api-1"), "{operations:?}");
        assert!(operations.iter().any(|operation| operation == "action:old-api:Start"), "{operations:?}");
        let rename_index = operations
            .iter()
            .position(|operation| operation.starts_with("rename:old-api:dbx-backup-"))
            .expect("backup rename");
        let first_create_index =
            operations.iter().position(|operation| operation == "create-container:1").expect("first create");
        assert!(rename_index < first_create_index, "{operations:?}");
    }

    #[tokio::test]
    async fn rejects_a_later_invalid_service_without_mutating_the_previous_deployment() {
        let runtime = FakeRuntime::replacement(FakeState::default());
        let request = DockerComposeApplyRequest {
            project_name: "demo".to_string(),
            content: r#"
services:
  api:
    image: example/api:new
  invalid:
    image: example/invalid:new
    ports:
      - "not-a-port"
"#
            .to_string(),
            replace_existing: true,
        };

        let error = apply_compose_with_runtime(&runtime, request)
            .await
            .expect_err("invalid service must reject the complete plan");

        assert!(error.contains("Invalid Compose port mapping"), "{error}");
        assert!(runtime.operations().is_empty(), "{:?}", runtime.operations());
    }

    #[tokio::test]
    async fn leaves_the_previous_deployment_running_when_backup_staging_fails() {
        let runtime = FakeRuntime::replacement(FakeState { fail_backup_rename: true, ..FakeState::default() });
        let error =
            apply_compose_with_runtime(&runtime, replacement_request()).await.expect_err("backup rename must fail");

        assert!(error.contains("previous Compose deployment was left unchanged"), "{error}");
        let operations = runtime.operations();
        assert!(operations.iter().any(|operation| operation.starts_with("rename:old-api:dbx-backup-")));
        assert!(!operations.iter().any(|operation| operation == "action:old-api:Stop"), "{operations:?}");
        assert!(operations.iter().any(|operation| operation.starts_with("remove-network:")), "{operations:?}");
    }

    #[tokio::test]
    async fn removes_all_replacements_and_restores_previous_state_when_start_fails() {
        let runtime = FakeRuntime::replacement(FakeState { fail_start_new: true, ..FakeState::default() });
        let error =
            apply_compose_with_runtime(&runtime, replacement_request()).await.expect_err("replacement start must fail");

        assert!(error.contains("previous Compose deployment was restored"), "{error}");
        let operations = runtime.operations();
        assert!(operations.iter().any(|operation| operation == "remove-container:new-1"), "{operations:?}");
        assert!(operations.iter().any(|operation| operation == "remove-container:new-2"), "{operations:?}");
        assert!(operations.iter().any(|operation| operation == "action:old-api:Start"), "{operations:?}");
    }

    #[tokio::test]
    async fn reports_partial_rollback_failures_without_claiming_restoration() {
        let runtime = FakeRuntime::replacement(FakeState {
            fail_create_at: Some(2),
            fail_restore_rename: true,
            ..FakeState::default()
        });
        let error = apply_compose_with_runtime(&runtime, replacement_request())
            .await
            .expect_err("replacement and restore must fail");

        assert!(error.contains("rollback encountered"), "{error}");
        assert!(error.contains("restore rename failed"), "{error}");
        assert!(!error.contains("was restored"), "{error}");
    }
}
