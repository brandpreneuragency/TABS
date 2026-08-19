import type { ReactNode } from 'react';
import { CENTER_MIN_PX } from '../../../stores/layoutGeometry';

interface CenterContentPanelProps {
  children: ReactNode;
  subtasksBar?: ReactNode;
  showSubtasksBar?: boolean;
  leadingControls?: ReactNode;
}

/**
 * Common center panel shell: optional subtasks bar + scrollable body.
 * Stable identity — not remounted on wrapper swap.
 */
export function CenterContentPanel({
  children,
  subtasksBar,
  showSubtasksBar,
  leadingControls,
}: CenterContentPanelProps) {
  return (
    <div
      id="center-panel"
      className="center-content-panel panel flex-1 h-full overflow-h flex-col min-w-0"
      style={{ minWidth: CENTER_MIN_PX }}
    >
      {(showSubtasksBar && subtasksBar) || leadingControls ? (
        <div
          className="subtasks-bar-wrapper"
          style={{
            paddingTop: '10px',
            paddingBottom: '10px',
            paddingLeft: '10px',
            paddingRight: '10px',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          {leadingControls}
          {showSubtasksBar ? subtasksBar : null}
        </div>
      ) : null}
      <div id="center-panel-body" className="panel-body flex-1 min-h-0 overflow-h">
        {children}
      </div>
    </div>
  );
}
