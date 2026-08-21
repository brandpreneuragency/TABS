import {
  KanbanSquare,
  Palette,
  UserPlus,
  Zap,
  FileText,
  Inbox,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { Calendar, Folder, List } from 'lucide-react';
import type { CRMPage, FormsPage, SettingsSubTab, TaskPage } from '../../stores/uiStore';

export interface ModuleNavItem<T extends string> {
  key: T;
  label: string;
  icon: LucideIcon;
}

/**
 * A header tab for the CRM module. CRM hosts the merged Forms sub-module:
 * tabs with a `formsPage` switch the CRM workspace to the `forms` page and
 * select that Forms sub-page. `key` doubles as the DOM id suffix
 * (`tab-module-active-${key}`), so it matches the Forms sub-page keys
 * (`list` / `submissions`) for stable element ids.
 */
export interface CRMHeaderTab {
  key: string;
  label: string;
  icon: LucideIcon;
  /** CRM page to activate when this tab is clicked. */
  crmPage: Exclude<CRMPage, 'settings' | 'dashboard'>;
  /** When set, this tab also selects a Forms sub-page under the `forms` CRM page. */
  formsPage?: FormsPage;
  /** Extra Forms sub-pages that should also highlight this tab (e.g. builder for the Forms tab). */
  alsoActiveFor?: FormsPage[];
}

export const CRM_HEADER_TABS: CRMHeaderTab[] = [
  { key: 'leads', label: 'Leads', icon: UserPlus, crmPage: 'leads' },
  { key: 'pipeline', label: 'Pipeline', icon: KanbanSquare, crmPage: 'pipeline' },
  { key: 'list', label: 'Forms', icon: FileText, crmPage: 'forms', formsPage: 'list', alsoActiveFor: ['builder'] },
  { key: 'submissions', label: 'Submissions', icon: Inbox, crmPage: 'forms', formsPage: 'submissions' },
];

export const TASK_HEADER_TABS: ModuleNavItem<TaskPage>[] = [
  { key: 'list', label: 'List', icon: List },
  { key: 'calendar', label: 'Calendar', icon: Calendar },
  { key: 'projects', label: 'Projects', icon: Folder },
];

export const SETTINGS_HEADER_TABS: ModuleNavItem<SettingsSubTab>[] = [
  { key: 'tools', label: 'Tools', icon: Wrench },
  { key: 'actions', label: 'Actions', icon: Zap },
  { key: 'appearance', label: 'Appearance', icon: Palette },
];
