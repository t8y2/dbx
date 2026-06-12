use serde::{Deserialize, Serialize};

/// Events emitted by the agent loop, streamed to the frontend via SSE.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentEvent {
    /// A turn in the agent loop has started.
    TurnStart { turn: u32 },
    /// Text delta from the LLM response.
    TextDelta { delta: String },
    /// Reasoning/thinking delta (for models that support it).
    ReasoningDelta { delta: String },
    /// The LLM wants to call a tool.
    ToolCallStart { tool_call_id: String, tool_name: String, args: serde_json::Value },
    /// A tool execution has completed.
    ToolCallEnd { tool_call_id: String, tool_name: String, result: serde_json::Value, is_error: bool },
    /// A turn in the agent loop has ended.
    TurnEnd { turn: u32 },
    /// The agent loop has finished.
    AgentEnd { total_tokens: Option<u64> },
    /// An error occurred during the agent loop.
    Error { message: String },
}

/// A unified tool call extracted from any provider's response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
}

/// Result of executing a tool.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolResult {
    pub tool_call_id: String,
    pub tool_name: String,
    pub content: String,
    pub is_error: bool,
}

/// Definition of a tool available to the agent.
#[derive(Debug, Clone)]
pub struct ToolDefinition {
    pub name: &'static str,
    pub description: &'static str,
    pub parameters: serde_json::Value,
    pub read_only: bool,
}

impl ToolDefinition {
    /// Convert to OpenAI-compatible tool JSON for the API request.
    pub fn to_openai_tool(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters
            }
        })
    }
    /// Convert to Anthropic-compatible tool JSON.
    pub fn to_anthropic_tool(&self) -> serde_json::Value {
        serde_json::json!({
            "name": self.name,
            "description": self.description,
            "input_schema": self.parameters
        })
    }
    /// Convert to Gemini-compatible function declaration.
    pub fn to_gemini_tool(&self) -> serde_json::Value {
        serde_json::json!({
            "name": self.name,
            "description": self.description,
            "parameters": self.parameters
        })
    }
}
