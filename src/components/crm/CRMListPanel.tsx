import './crmLayout.css';
import { Plus } from 'lucide-react';
import { useUIStore, type CRMPage } from '../../stores/uiStore';
import { useCrmStore } from '../../stores/crmStore';
import { DashboardSavedViews } from './lists/DashboardSavedViews';
import { LeadList } from './lists/LeadList';
import { SettingsNav } from './lists/SettingsNav';
import { useCrmSettingsTab } from './pages/CRMSettingsPage';
import { AgentLaunchButton } from '../agent/AgentLaunchButton';

const CRM_LIST_TITLES: Record<CRMPage, string> = {
  dashboard: 'Dashboard',
  leads: 'Leads',
  contacts: 'Contacts',
  companies: 'Companies',
  pipeline: 'Pipeline',
  activities: 'Activity',
  forms: 'Forms',
  settings: 'Settings',
};

const ADD_LABELS: Partial<Record<CRMPage, string>> = {
  leads: 'Add lead',
};

/**
 * Panel 1 for the CRM module. Renders the per-page list/filter component and
 * a `+ Add` footer for the entity pages. Module navigation lives in the top
 * header (see TabBar); this panel only composes the per-page lists and wires
 * the add buttons to the store's create actions. Settings tab state is shared
 * with CRMSettingsPage via useCrmSettingsTab so clicking a section here
 * switches Panel 2.
 */
export function CRMListPanel() {
  const { activeCRMPage } = useUIStore();
  const { createLead } = useCrmStore();
  const { tab: settingsTab, setTab: setSettingsTab } = useCrmSettingsTab();

  const addLabel = ADD_LABELS[activeCRMPage];

  const handleAdd = async () => {
    if (activeCRMPage !== 'leads') return;
    const title = window.prompt('New lead title');
    if (title && title.trim()) {
      await createLead({ title: title.trim(), ownerId: 'you' });
    }
  };

  return (
    <div
      id="crm-list-panel"
      className="panel flex-col h-full overflow-hidden"
      style={{ marginLeft: '0px', marginRight: '0px' }}
    >
      <div
        className="crm-list-content ai-scroll flex-1 overflow-y-a h-full"
        style={{
          display: 'flex',
          flexDirection: 'column',
          paddingLeft: '18px',
          paddingRight: '12px',
          paddingTop: '12px',
        }}
      >
        {activeCRMPage === 'dashboard' && <DashboardSavedViews />}
        {activeCRMPage === 'leads' && <LeadList />}
        {activeCRMPage === 'settings' && (
          <SettingsNav active={settingsTab} onChange={setSettingsTab} />
        )}
      </div>

      <div className="panel-footer crm-list-footer">
        {addLabel ? (
          <button
            type="button"
            className="crm-list-add-btn"
            title={addLabel}
            onClick={() => void handleAdd()}
          >
            <Plus size={14} />
            <span>{addLabel}</span>
          </button>
        ) : (
          <span className="crm-list-footer-hint subtle">{CRM_LIST_TITLES[activeCRMPage]}</span>
        )}
        <AgentLaunchButton source="crm" />
      </div>
    </div>
  );
}
