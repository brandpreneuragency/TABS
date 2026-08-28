use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Default)]
pub struct ToolCancelRegistry {
    tokens: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl ToolCancelRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn begin(&self, id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        if let Ok(mut tokens) = self.tokens.lock() {
            tokens.insert(id.to_string(), Arc::clone(&flag));
        }
        flag
    }

    pub fn flag(&self, id: &str) -> Arc<AtomicBool> {
        if let Ok(tokens) = self.tokens.lock() {
            if let Some(existing) = tokens.get(id) {
                return Arc::clone(existing);
            }
        }
        self.begin(id)
    }

    pub fn cancel(&self, id: &str) -> bool {
        if let Ok(tokens) = self.tokens.lock() {
            if let Some(flag) = tokens.get(id) {
                flag.store(true, Ordering::SeqCst);
                return true;
            }
        }
        false
    }

    pub fn finish(&self, id: &str) {
        if let Ok(mut tokens) = self.tokens.lock() {
            tokens.remove(id);
        }
    }

    pub fn is_cancelled(flag: &AtomicBool) -> bool {
        flag.load(Ordering::SeqCst)
    }
}

#[tauri::command]
pub fn ai_tool_cancel(
    state: tauri::State<'_, ToolCancelRegistry>,
    cancel_id: String,
) -> Result<bool, String> {
    Ok(state.cancel(&cancel_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancel_flips_the_flag_for_a_known_id() {
        let registry = ToolCancelRegistry::new();
        let flag = registry.begin("op-1");
        assert!(!ToolCancelRegistry::is_cancelled(&flag));
        assert!(registry.cancel("op-1"));
        assert!(ToolCancelRegistry::is_cancelled(&flag));
        assert!(!registry.cancel("missing"));
    }
}
