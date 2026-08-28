import { ArrowLeftRight } from 'lucide-react';
import { TabBar } from './TabBar';
import { AssistantToggle, ContextPanelToggle } from '../layout/workspace';
import { selectCanSwapWrappers, useUIStore } from '../../stores/uiStore';

export function Header() {
  const wrappersSwapped = useUIStore((s) => s.wrappersSwapped);
  const toggleWrappersSwapped = useUIStore((s) => s.toggleWrappersSwapped);
  const canSwapWrappers = useUIStore(selectCanSwapWrappers);

  const swapLabel = wrappersSwapped
    ? 'Restore workspace and assistant order'
    : 'Swap workspace and assistant';

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
        <AssistantToggle variant="header" />
      </div>
    </div>
  );
}
