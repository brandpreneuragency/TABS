import { useEffect } from 'react';
import './formsLayout.css';
import './forms.css';
import { Plus } from 'lucide-react';
import { useUIStore, type FormsPage } from '../../stores/uiStore';
import { useFormsStore } from '../../stores/formsStore';
import { FormsNavList } from './lists/FormsNavList';
import { FormList } from './lists/FormList';
import { SubmissionList } from './lists/SubmissionList';
import { SettingsNav } from './lists/SettingsNav';
import { AgentLaunchButton } from '../agent/AgentLaunchButton';

const FORMS_LIST_TITLE: Record<Exclude<FormsPage, 'templates'>, string> = {
  dashboard: 'Recent Forms',
  list: 'Forms',
  builder: 'Forms',
  submissions: 'Submissions',
  settings: 'Sections',
};

function renderPanel1List(page: FormsPage) {
  switch (page) {
    case 'dashboard':
      return <FormsNavList />;
    case 'list':
    case 'builder':
    case 'templates':
      return <FormList />;
    case 'submissions':
      return <SubmissionList />;
    case 'settings':
      return <SettingsNav />;
  }
}

export function FormsListPanel() {
  const { activeFormsPage, setActiveFormsPage } = useUIStore();
  const isLoaded = useFormsStore((s) => s.isLoaded);
  const loadForms = useFormsStore((s) => s.loadForms);
  const createForm = useFormsStore((s) => s.createForm);
  const showToast = useUIStore((s) => s.showToast);

  useEffect(() => {
    if (!isLoaded) void loadForms();
  }, [isLoaded, loadForms]);

  const handleNewForm = async () => {
    const form = await createForm('Untitled Form');
    if (form) {
      setActiveFormsPage('builder');
      showToast('New form created. Opening builder.', 'info');
    }
  };

  const showAddButton =
    activeFormsPage === 'list' || activeFormsPage === 'builder' || activeFormsPage === 'templates';

  const footerTitle =
    activeFormsPage === 'templates' ? 'Forms' : FORMS_LIST_TITLE[activeFormsPage];

  return (
    <div
      id="forms-list-panel"
      className="panel flex-col h-full overflow-hidden"
      style={{ marginLeft: '0px', marginRight: '0px' }}
    >
      <div
        className="forms-list-content ai-scroll flex-1 overflow-y-a h-full"
        style={{ display: 'flex', flexDirection: 'column', paddingLeft: '18px', paddingRight: '12px', paddingTop: '12px' }}
      >
        {renderPanel1List(activeFormsPage)}
      </div>

      <div className="panel-footer forms-list-footer">
        {showAddButton ? (
          <button type="button" className="forms-list-add-btn" title="New form" onClick={handleNewForm}>
            <Plus size={14} />
            <span>New form</span>
          </button>
        ) : (
          <span className="forms-list-footer-hint subtle">{footerTitle}</span>
        )}
        <AgentLaunchButton source="forms" />
      </div>
    </div>
  );
}
