import type { IntegrationGroup, MemNode, ModalPanel, PlanItem, Step, StepKind, Task, ToastKind } from './types';

export const S = (kind: StepKind, text: string, time: string): Step => ({ kind, text, time });
export const P = (kind: StepKind, text: string, extra?: Partial<PlanItem>): PlanItem => ({ kind, text, ...(extra || {}) });
export const clock = () => new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export const KIND_ICON: Record<StepKind, string> = {
  browse: 'ph-cursor-click', api: 'ph-plugs-connected', search: 'ph-magnifying-glass', think: 'ph-brain',
  fix: 'ph-wrench', approval: 'ph-hand-palm', user: 'ph-user-check', done: 'ph-check-circle',
  shell: 'ph-terminal-window', file: 'ph-file-text', memory: 'ph-graph', error: 'ph-warning-circle', data: 'ph-chart-bar',
};
export const MODE_ICON = (m: string) =>
  m === 'Search' ? 'ph-magnifying-glass' : m === 'API' ? 'ph-plugs-connected' : m === 'Browser' ? 'ph-cursor-click' : m === 'CLI' ? 'ph-terminal-window' : 'ph-stack';
export const TOAST_ICON: Record<ToastKind, string> = {
  fix: 'ph-wrench', approval: 'ph-hand-palm', done: 'ph-check-circle', start: 'ph-play-circle', question: 'ph-question',
};

export const seedTasks = (): Task[] => [
  { id: 't1', title: 'Reconcile BevSpot inventory against Toast sales for September', app: 'BevSpot + Toast', mode: 'Browser + API', url: 'BevSpot › Inventory › Counts', status: 'running',
    steps: [S('api', 'Pulled 4,812 Toast line items for Sept 1–26', '9:58 AM'), S('browse', 'Opened BevSpot › Inventory › Counts', '10:06 AM'), S('fix', 'BevSpot moved its Export button into the ⋯ menu. Found it and updated my selector.', '10:14 AM')],
    fix: { text: 'BevSpot changed its export menu in a UI update. Jarvis located the new control, rewrote its own automation step and kept going. No action needed.', time: '10:14 AM' },
    plan: [P('browse', 'Exported counts for Downtown, Eastside and Lakeview'), P('think', 'Matched 212 BevSpot SKUs to Toast menu items'), P('think', '9 SKUs show variance above 8%'), P('api', 'Wrote variance sheet to SharePoint › Ops › Inventory')] },
  { id: 't2', title: 'Pull M3 P&L for all locations and flag variances over 5%', app: 'M3', mode: 'Browser', url: 'M3 › Reports › P&L › Period 9', status: 'running',
    steps: [S('browse', 'Signed in to M3 with stored credentials', '10:02 AM'), S('browse', 'Opened Reports › P&L › Period 9', '10:05 AM')],
    plan: [P('browse', 'Downloaded Downtown P&L'), P('browse', 'Downloaded Eastside P&L'), P('fix', 'M3 session timed out mid-download. Signed back in and resumed from Lakeview.', { fixNote: 'M3 logged Jarvis out during a download. It signed back in, skipped the files it already had and resumed.' }), P('browse', 'Downloaded Lakeview P&L'), P('think', '4 lines are over budget by more than 5%'), P('api', 'Saved summary to Excel › Finance › P9 variance.xlsx')] },
  { id: 't3', title: 'Research wine-by-the-glass pricing at 5 nearby competitors', app: 'Web', mode: 'Search', url: 'Search › wine by the glass menus near Downtown', status: 'running',
    steps: [S('search', 'Found 11 candidate restaurants within 2 miles', '10:09 AM'), S('browse', 'Reading menus (3 of 5)', '10:15 AM')],
    plan: [P('browse', 'Read menus (5 of 5)'), P('think', 'Normalized pours to 5 oz'), P('think', 'Our median glass is $2 above the set'), P('api', 'Saved findings to Memory › Wine pricing study')] },
  { id: 't4', title: 'Draft weekly ops summary for leadership', app: 'Outlook', mode: 'API', url: 'Outlook › Drafts', status: 'waiting',
    steps: [S('api', 'Collected notes from Teams › Ops channel', '9:40 AM'), S('think', 'Drafted a 6-bullet summary with P8 numbers', '9:47 AM'), S('approval', 'Waiting for your approval: Send email to leadership', '9:48 AM')],
    approval: { action: 'Send email to leadership', detail: '5 recipients · Subject: Weekly ops summary, Sept 22–26', risk: 'Send' },
    plan: [P('api', 'Sent via Outlook'), P('api', 'Filed a copy to SharePoint › Ops › Weekly')] },
  { id: 't5', title: 'Remove duplicate files from the Q3 vendor folder', app: 'SharePoint', mode: 'API', url: 'SharePoint › Vendors › Q3', status: 'waiting',
    steps: [S('api', 'Scanned 318 files in Vendors › Q3', '9:30 AM'), S('think', 'Found 14 exact duplicates; originals stay in place', '9:34 AM'), S('approval', 'Waiting for your approval: Delete 14 duplicate files', '9:34 AM')],
    approval: { action: 'Delete 14 duplicate files', detail: 'Vendors › Q3 · recoverable from the recycle bin for 93 days', risk: 'Delete' },
    plan: [P('api', 'Moved 14 files to the recycle bin')] },
  { id: 't6', title: "Pay Southern Glazer's invoice #88213", app: 'Vendor portal', mode: 'Browser', url: 'Vendor portal › Invoices › 88213', status: 'running',
    steps: [S('browse', 'Opened the vendor portal', '10:11 AM'), S('think', 'Invoice matches PO 4471 and BevSpot receiving', '10:13 AM')],
    plan: [P('approval', '', { approval: { action: 'Pay $4,386.20', detail: "Southern Glazer's · ACH from operating account · due Sept 30", risk: 'Pay' } }), P('browse', 'Payment submitted; confirmation saved to Drive')] },
  { id: 't7', title: 'Book vendor review meetings for next week', app: 'Google Calendar', mode: 'API', url: 'Calendar › Next week', status: 'done',
    steps: [S('api', 'Checked 4 calendars for open time', '8:50 AM'), S('api', 'Held 3 slots Tue–Thu', '8:52 AM'), S('user', 'You approved: Send 3 invites', '9:05 AM'), S('done', 'Task complete', '9:05 AM')], plan: [] },
  { id: 't8', title: 'Add new vendor contacts to memory', app: 'Memory', mode: 'API', url: 'Memory graph', status: 'done',
    steps: [S('api', 'Read 22 vendor emails in Gmail', '8:31 AM'), S('think', 'Extracted 6 new contacts and 2 role changes', '8:33 AM'), S('api', 'Linked contacts to vendors and locations', '8:34 AM'), S('done', 'Task complete', '8:34 AM')], plan: [] },
];

export const seedInteg = (): IntegrationGroup[] => [
  { g: 'Microsoft 365', items: [
    { id: 'outlook', name: 'Outlook', icon: 'ph-microsoft-outlook-logo', desc: 'Read, draft and send mail. Sending asks you first.', modes: ['API'], on: true, last: 'Used 9:48 AM' },
    { id: 'teams', name: 'Teams', icon: 'ph-microsoft-teams-logo', desc: 'Read channels and post updates to you.', modes: ['API'], on: true, last: 'Used 9:40 AM' },
    { id: 'sharepoint', name: 'SharePoint & OneDrive', icon: 'ph-folders', desc: 'Files and folders across your sites.', modes: ['API'], on: true, last: 'Used 9:34 AM' },
    { id: 'excel', name: 'Excel', icon: 'ph-microsoft-excel-logo', desc: 'Build and update workbooks.', modes: ['API'], on: true, last: 'Used yesterday' }] },
  { g: 'Google Workspace', items: [
    { id: 'gmail', name: 'Gmail', icon: 'ph-envelope-simple', desc: 'Read and draft mail. Sending asks you first.', modes: ['API'], on: true, last: 'Used 8:31 AM' },
    { id: 'gcal', name: 'Calendar', icon: 'ph-calendar-blank', desc: 'Find time, hold slots and send invites.', modes: ['API'], on: true, last: 'Used 9:05 AM' },
    { id: 'drive', name: 'Drive', icon: 'ph-google-drive-logo', desc: 'Docs, Sheets and shared folders.', modes: ['API'], on: false, last: 'Not connected' }] },
  { g: 'Operations systems', items: [
    { id: 'm3', name: 'M3', icon: 'ph-browser', desc: 'Accounting and P&L. No API, so Jarvis signs in and navigates like you do.', modes: ['Browser'], on: true, last: 'Working now' },
    { id: 'toast', name: 'Toast', icon: 'ph-receipt', desc: 'Sales, menus and labor. API for data, browser for reports the API lacks.', modes: ['API', 'Browser'], pref: 'Both', on: true, last: 'Working now' },
    { id: 'bevspot', name: 'BevSpot', icon: 'ph-wine', desc: 'Inventory counts, orders and receiving through the web app.', modes: ['Browser'], on: true, last: 'Working now' }] },
  { g: 'Knowledge', items: [
    { id: 'memory', name: 'Memory graph', icon: 'ph-graph', desc: 'People, vendors, locations and systems Jarvis has learned.', modes: ['API'], on: true, last: 'Updated 8:34 AM' },
    { id: 'web', name: 'Web research', icon: 'ph-globe', desc: 'Searches and reads public pages in its own browser.', modes: ['Browser'], on: true, last: 'Working now' }] },
];

export const NODES: MemNode[] = [
  { id: 'n0', label: 'Cicero HG', type: 'Organization', x: 50, y: 48, facts: ['Three locations: Downtown, Eastside, Lakeview', 'Fiscal periods run 4-4-5'], source: 'Learned from SharePoint › Company' },
  { id: 'n1', label: 'Downtown', type: 'Location', x: 26, y: 24, facts: ['Highest wine volume of the three', 'Menu last repriced in June'], source: 'Learned from Toast sales' },
  { id: 'n2', label: 'Eastside', type: 'Location', x: 20, y: 72, facts: ['Opened 2023', 'Counts inventory on Mondays'], source: 'Learned from BevSpot' },
  { id: 'n3', label: 'Lakeview', type: 'Location', x: 48, y: 86, facts: ['Seasonal patio from May to September'], source: 'Learned from Teams › Ops' },
  { id: 'n4', label: 'Toast', type: 'System', x: 78, y: 28, facts: ['POS for all three locations', 'API covers sales and menus; labor reports need the browser'], source: 'Learned while connecting' },
  { id: 'n5', label: 'BevSpot', type: 'System', x: 80, y: 62, facts: ['Inventory and ordering', 'Export moved to the ⋯ menu on Sept 27'], source: 'Learned during a task' },
  { id: 'n6', label: 'M3', type: 'System', x: 62, y: 14, facts: ['Accounting and P&L', 'Sessions time out after about 15 minutes'], source: 'Learned during a task' },
  { id: 'n7', label: "Southern Glazer's", type: 'Vendor', x: 86, y: 86, facts: ['Primary wine and spirits vendor', 'Net 30 terms, paid by ACH'], source: 'Learned from Gmail' },
  { id: 'n8', label: 'Sysco', type: 'Vendor', x: 9, y: 46, facts: ['Broadline food vendor for Downtown and Eastside'], source: 'Learned from Gmail' },
  { id: 'n9', label: 'Dana Ruiz', type: 'Person', x: 36, y: 10, facts: ['Controller', 'Wants variance flags above 5%'], source: 'Learned from chat' },
  { id: 'n10', label: 'Marco Bell', type: 'Person', x: 66, y: 76, facts: ['Beverage director', 'Owns the wine list and pricing'], source: 'Learned from Teams › Ops' },
  { id: 'n11', label: 'Q3 inventory audit', type: 'Project', x: 34, y: 56, facts: ['Due Oct 10', 'Covers beer, wine and spirits'], source: 'Learned from Outlook' },
  { id: 'n12', label: 'Wine pricing study', type: 'Project', x: 90, y: 44, facts: ['Started today', 'Compares 5 nearby competitors'], source: 'Created by Jarvis' },
];

export const EDGES: [string, string][] = [['n0', 'n1'], ['n0', 'n2'], ['n0', 'n3'], ['n0', 'n4'], ['n0', 'n5'], ['n0', 'n6'], ['n0', 'n9'], ['n1', 'n4'], ['n2', 'n4'], ['n3', 'n4'], ['n5', 'n10'], ['n5', 'n7'], ['n7', 'n10'], ['n6', 'n9'], ['n8', 'n1'], ['n8', 'n2'], ['n11', 'n5'], ['n11', 'n10'], ['n11', 'n9'], ['n12', 'n10'], ['n12', 'n1'], ['n12', 'n4']];

export const TYPE_FILL: Record<MemNode['type'], string> = {
  Organization: 'var(--color-accent)', Location: 'var(--color-accent-300)', System: 'var(--color-neutral-300)',
  Vendor: 'var(--color-neutral-500)', Person: 'var(--color-accent-500)', Project: 'var(--color-accent-700)',
};

export const MODALS: Record<ModalPanel, [string, string]> = {
  task: ['ph-pulse', 'Task'], tasks: ['ph-list-checks', 'All tasks'], approvals: ['ph-hand-palm', 'Approvals'],
  memory: ['ph-graph', 'Memory'], integrations: ['ph-plugs', 'Integrations'], settings: ['ph-gear-six', 'Settings'],
};

export const SUGGESTIONS = [
  'Compare last week’s BevSpot usage to Toast sales at Eastside',
  'What needs my decision right now?',
  'Research happy hour pricing at 3 competitors near Lakeview',
];
