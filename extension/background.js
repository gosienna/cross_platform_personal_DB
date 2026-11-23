/* Service worker: opens the side panel, runs the scheduled Google Drive backup. */
importScripts('lib/schema.js', 'lib/core.js', 'lib/db.js', 'lib/crypto.js', 'lib/zip.js', 'lib/backup.js');

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  chrome.alarms.create('pdb-backup-check', { periodInMinutes: 24 * 60, delayInMinutes: 5 });
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.get('pdb-backup-check', (a) => { if (!a) chrome.alarms.create('pdb-backup-check', { periodInMinutes: 24 * 60, delayInMinutes: 5 }); });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'pdb-backup-check') return;
  try {
    const r = await PDB.backup.runIfDue({ interactive: false });
    if (r && r.status === 'needs-passphrase') chrome.action.setBadgeText({ text: '🔑' });
    else if (r && r.status === 'error') { chrome.action.setBadgeText({ text: '!' }); chrome.action.setBadgeBackgroundColor({ color: '#d33' }); }
    else if (r && r.status === 'ok') chrome.action.setBadgeText({ text: '' });
  } catch (e) {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#d33' });
  }
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg && msg.type === 'pdb:openDashboard') { chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html' + (msg.hash || '')) }); }
  if (msg && msg.type === 'pdb:backupNow') {
    PDB.backup.run({ interactive: true, force: true }).then((r) => { chrome.action.setBadgeText({ text: r.status === 'ok' ? '' : '!' }); reply(r); }, (e) => reply({ status: 'error', message: String(e.message || e) }));
    return true;
  }
});
