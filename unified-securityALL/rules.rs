use axum::http::{HeaderMap, Method, Uri};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::RwLock;
use crate::config::WafConfig;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Rule {
    pub id: String,
    pub name: String,
    pub description: String,
    pub enabled: bool,
    pub action: RuleAction,
    pub conditions: Vec<Condition>,
    pub ban_duration: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuleAction {
    Block,
    Log,
    Challenge,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Condition {
    pub field: ConditionField,
    pub operator: ConditionOperator,
    pub value: String,
    pub case_sensitive: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConditionField {
    Method,
    Path,
    Query,
    Header(String),
    Body,
    IpAddress,
    UserAgent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConditionOperator {
    Equals,
    NotEquals,
    Contains,
    NotContains,
    StartsWith,
    EndsWith,
    Regex,
    LengthGreater,
    LengthLess,
}

#[derive(Debug, Clone)]
pub struct RuleViolation {
    pub rule_id: String,
    pub rule_name: String,
    pub action: RuleAction,
    pub ban_duration: u64,
}

pub struct RuleEngine {
    config: Arc<WafConfig>,
    rules: Arc<RwLock<Vec<Rule>>>,
}

impl RuleEngine {
    pub fn new(config: Arc<WafConfig>) -> Self {
        let default_rules = vec![
            Rule {
                id: "block_admin_path".to_string(),
                name: "Block unauthorized admin access".to_string(),
                description: "Block access to /admin paths from non-whitelisted IPs".to_string(),
                enabled: true,
                action: RuleAction::Block,
                conditions: vec![Condition {
                    field: ConditionField::Path,
                    operator: ConditionOperator::StartsWith,
                    value: "/admin".to_string(),
                    case_sensitive: false,
                }],
                ban_duration: 300,
            },
            Rule {
                id: "block_php_files".to_string(),
                name: "Block PHP file access".to_string(),
                description: "Block access to PHP files that shouldn't be directly accessible".to_string(),
                enabled: true,
                action: RuleAction::Block,
                conditions: vec![Condition {
                    field: ConditionField::Path,
                    operator: ConditionOperator::EndsWith,
                    value: ".php".to_string(),
                    case_sensitive: false,
                }],
                ban_duration: 600,
            },
            Rule {
                id: "block_sql_keywords".to_string(),
                name: "Block SQL keywords in query".to_string(),
                description: "Block requests with common SQL keywords".to_string(),
                enabled: true,
                action: RuleAction::Block,
                conditions: vec![Condition {
                    field: ConditionField::Query,
                    operator: ConditionOperator::Regex,
                    value: r"(?i)(union|select|insert|update|delete|drop|create|alter)\s".to_string(),
                    case_sensitive: false,
                }],
                ban_duration: 3600,
            },
            Rule {
                id: "suspicious_user_agent".to_string(),
                name: "Suspicious User Agent".to_string(),
                description: "Block known malicious user agents".to_string(),
                enabled: true,
                action: RuleAction::Block,
                conditions: vec![Condition {
                    field: ConditionField::UserAgent,
                    operator: ConditionOperator::Regex,
                    value: r"(?i)(nikto|sqlmap|nmap|masscan|nessus|burp|metasploit|havij|acunetix)".to_string(),
                    case_sensitive: false,
                }],
                ban_duration: 3600,
            },
            Rule {
                id: "large_query_string".to_string(),
                name: "Large Query String".to_string(),
                description: "Block excessively large query strings".to_string(),
                enabled: true,
                action: RuleAction::Block,
                conditions: vec![Condition {
                    field: ConditionField::Query,
                    operator: ConditionOperator::LengthGreater,
                    value: "2048".to_string(),
                    case_sensitive: false,
                }],
                ban_duration: 300,
            },
            Rule {
                id: "block_dot_env".to_string(),
                name: "Block .env file access".to_string(),
                description: "Block attempts to access .env files".to_string(),
                enabled: true,
                action: RuleAction::Block,
                conditions: vec![Condition {
                    field: ConditionField::Path,
                    operator: ConditionOperator::Contains,
                    value: ".env".to_string(),
                    case_sensitive: false,
                }],
                ban_duration: 3600,
            },
            Rule {
                id: "block_git_directory".to_string(),
                name: "Block .git directory access".to_string(),
                description: "Block attempts to access .git directory".to_string(),
                enabled: true,
                action: RuleAction::Block,
                conditions: vec![Condition {
                    field: ConditionField::Path,
                    operator: ConditionOperator::Contains,
                    value: ".git/".to_string(),
                    case_sensitive: false,
                }],
                ban_duration: 3600,
            },
        ];
        
        Self {
            config,
            rules: Arc::new(RwLock::new(default_rules)),
        }
    }
    
    pub async fn check_request(
        &self,
        method: &Method,
        uri: &Uri,
        headers: &HeaderMap,
        body: &str,
    ) -> Option<RuleViolation> {
        let rules = self.rules.read().await;
        
        for rule in rules.iter() {
            if !rule.enabled {
                continue;
            }
            
            let all_conditions_met = rule.conditions.iter().all(|condition| {
                self.check_condition(condition, method, uri, headers, body)
            });
            
            if all_conditions_met {
                return Some(RuleViolation {
                    rule_id: rule.id.clone(),
                    rule_name: rule.name.clone(),
                    action: rule.action.clone(),
                    ban_duration: rule.ban_duration,
                });
            }
        }
        
        None
    }
    
    fn check_condition(
        &self,
        condition: &Condition,
        method: &Method,
        uri: &Uri,
        headers: &HeaderMap,
        body: &str,
    ) -> bool {
        let field_value = match &condition.field {
            ConditionField::Method => method.to_string(),
            ConditionField::Path => uri.path().to_string(),
            ConditionField::Query => uri.query().unwrap_or("").to_string(),
            ConditionField::Header(name) => {
                headers
                    .get(name)
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("")
                    .to_string()
            }
            ConditionField::Body => body.to_string(),
            ConditionField::IpAddress => return false, // Handled elsewhere
            ConditionField::UserAgent => {
                headers
                    .get("user-agent")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("")
                    .to_string()
            }
        };
        
        let field_value = if !condition.case_sensitive {
            field_value.to_lowercase()
        } else {
            field_value
        };
        
        let check_value = if !condition.case_sensitive {
            condition.value.to_lowercase()
        } else {
            condition.value.clone()
        };
        
        match &condition.operator {
            ConditionOperator::Equals => field_value == check_value,
            ConditionOperator::NotEquals => field_value != check_value,
            ConditionOperator::Contains => field_value.contains(&check_value),
            ConditionOperator::NotContains => !field_value.contains(&check_value),
            ConditionOperator::StartsWith => field_value.starts_with(&check_value),
            ConditionOperator::EndsWith => field_value.ends_with(&check_value),
            ConditionOperator::Regex => {
                if let Ok(re) = Regex::new(&check_value) {
                    re.is_match(&field_value)
                } else {
                    false
                }
            }
            ConditionOperator::LengthGreater => {
                if let Ok(length) = check_value.parse::<usize>() {
                    field_value.len() > length
                } else {
                    false
                }
            }
            ConditionOperator::LengthLess => {
                if let Ok(length) = check_value.parse::<usize>() {
                    field_value.len() < length
                } else {
                    false
                }
            }
        }
    }
    
    pub async fn get_rules(&self) -> Vec<Rule> {
        self.rules.read().await.clone()
    }
    
    pub async fn update_rules(&self, new_rules: Vec<Rule>) {
        let mut rules = self.rules.write().await;
        *rules = new_rules;
    }
    
    pub async fn add_rule(&self, rule: Rule) {
        let mut rules = self.rules.write().await;
        rules.push(rule);
    }
    
    pub async fn remove_rule(&self, rule_id: &str) {
        let mut rules = self.rules.write().await;
        rules.retain(|r| r.id != rule_id);
    }
    
    pub async fn enable_rule(&self, rule_id: &str) {
        let mut rules = self.rules.write().await;
        if let Some(rule) = rules.iter_mut().find(|r| r.id == rule_id) {
            rule.enabled = true;
        }
    }
    
    pub async fn disable_rule(&self, rule_id: &str) {
        let mut rules = self.rules.write().await;
        if let Some(rule) = rules.iter_mut().find(|r| r.id == rule_id) {
            rule.enabled = false;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{Method, Uri};

    #[tokio::test]
    async fn test_rule_matching() {
        let config = Arc::new(WafConfig::default());
        let engine = RuleEngine::new(config);
        
        let method = Method::GET;
        let uri = "/admin/users".parse::<Uri>().unwrap();
        let headers = HeaderMap::new();
        let body = "";
        
        let violation = engine.check_request(&method, &uri, &headers, body).await;
        assert!(violation.is_some());
        assert_eq!(violation.unwrap().rule_id, "block_admin_path");
    }
}
