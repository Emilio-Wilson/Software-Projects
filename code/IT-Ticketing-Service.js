// Comments moved to ./NOTES.md  (see "home.js" section).  22 note(s).
import { $, $$ } from '../core/dom.js';
import { initSubmitForm, hasUnsavedWork, requestLeave, setSubmitOrigin } from '../features/submitForm.js';
import { renderCharts } from './dashboard.js';
import { renderHistorical, resetHistoricalView } from './historical.js';
import { renderITToday, resetTodayFilter } from './itToday.js';
import { renderRequesterTable, resetRequesterView } from './requester.js';
import { isAdmin } from '../core/auth.js';




function clearFilters() {
    resetTodayFilter();        
    resetHistoricalView();     
    resetRequesterView();      
}


function currentView() {
    const el = $('.view.active');
    return el ? el.dataset.view : null;
}

function navigate(view) {
        
        
        
        if (view === 'itmembers' && !isAdmin()) view = 'home';

        const current = currentView();

        
        
        
        
        if (current === 'submit' && view !== 'submit' && hasUnsavedWork()) {
            requestLeave(view);
            return;
        }

        
        
        if (view === 'submit' && current && current !== 'submit') setSubmitOrigin(current);

        
        
        clearFilters();

        $$('.view').forEach(v => v.classList.toggle('active', v.dataset.view === view));
        $$('.nav-link').forEach(b => b.classList.toggle('active', b.dataset.nav === view));
        window.scrollTo({ top: 0, behavior: 'smooth' });

        if (view === 'requester') renderRequesterTable();
        if (view === 'submit') initSubmitForm();
        if (view === 'itmembers') {
            
            
            switchSubtab('today');
        }
    }

function switchSubtab(name) {
        $$('.sub-tab').forEach(b => b.classList.toggle('active', b.dataset.subtab === name));
        $$('.subview').forEach(s => s.classList.toggle('active', s.dataset.subview === name));
        if (name === 'charts') renderCharts();
        if (name === 'historical') renderHistorical();
        if (name === 'today') renderITToday();
    }

function renderHomeStats() {
        
    }

export { navigate, renderHomeStats, switchSubtab };