import { ArrowLeftRight, PanelRight } from 'lucide-react';
import { TabBar } from './TabBar';
import { ContextPanelToggle } from '../layout/workspace';
import { selectCanSwapWrappers, useUIStore } from '../../stores/uiStore';

export function Header() {
  const assistantOpen = useUIStore((s) => s.assistantWrapperOpen);
  const toggleAssistantWrapper = useUIStore((s) => s.toggleAssistantWrapper);
  const wrappersSwapped = useUIStore((s) => s.wrappersSwapped);
  const toggleWrappersSwapped = useUIStore((s) => s.toggleWrappersSwapped);
  const canSwapWrappers = useUIStore(selectCanSwapWrappers);

  const assistantLabel = assistantOpen ? 'Hide assistant' : 'Show assistant';
  const swapLabel = wrappersSwapped
    ? 'Restore workspace and assistant order'
    : 'Swap workspace and assistant';

  const handleAssistantToggle = () => {
    const assistantEl = document.getElementById('assistant-wrapper');
    const focusInside = Boolean(
      assistantOpen && assistantEl?.contains(document.activeElement),
    );
    toggleAssistantWrapper();
    if (focusInside) {
      requestAnimationFrame(() => {
        document.getElementById('header-btn-assistant')?.focus();
      });
    }
  };

  return (
    <div id="header-bar" className="header-bar">
      <TabBar />
      <div className="ai-toggle-col">
        <ContextPanelToggle variant="header" />
        <button
          id="header-btn-swap"
          type="button"
          title={canSwapWrappers ? swapLabel : 'Swap requires both workspace and assistant open'}
          aria-label={swapLabel}
          aria-pressed={wrappersSwapped}
          disabled={!canSwapWrappers}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={() => toggleWrappersSwapped()}
          className={`ai-toggle-btn${wrappersSwapped && canSwapWrappers ? ' ai-toggle-btn--on' : ''}`}
        >
          <ArrowLeftRight size={16} />
        </button>
        <button
          id="header-btn-assistant"
          type="button"
          title={assistantLabel}
          aria-label={assistantLabel}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={handleAssistantToggle}
          aria-pressed={assistantOpen}
          className={`ai-toggle-btn${assistantOpen ? ' ai-toggle-btn--on' : ''}`}
        >
          <PanelRight size={16} />
        </button>
      </div>
    </div>
  );
}
