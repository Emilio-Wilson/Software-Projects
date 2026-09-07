/* ─────────────────────────────────────────────
   home.js  —  Department Dashboard Home Page
───────────────────────────────────────────── */
(function () {
    'use strict';
    const DEPARTMENTS = [
        { icon: '✈️', name: 'Airside Operations', live: true, action: function () { Router.go('airside'); } },
        { icon: '🚌', name: 'Landside Operations', live: false },
        { icon: '⚙️', name: 'Engineering', live: false },
        { icon: '💻', name: 'Information Technology', live: false },
        { icon: '👔', name: 'C-Suite', live: false },
        { icon: '👥', name: 'Human Resources', live: false },
        { icon: '🏗️', name: 'Capital Projects', live: false },
        { icon: '🔧', name: 'Maintenance', live: false },
        { icon: '💰', name: 'Finance', live: false },
        { icon: '⚖️', name: 'Legal', live: false },
        { icon: '📣', name: 'Marketing', live: false },
        { icon: '🍽️', name: 'Kitchen', live: false },
        { icon: '🛡️', name: 'Police', live: false },
        { icon: '📡', name: 'Communications', live: false },
        { icon: '💡', name: 'Innovation', live: false },
    ];
    function getGreeting() {
        var h = new Date().getHours();
        if (h < 12) return 'Good Morning';
        if (h < 17) return 'Good Afternoon';
        return 'Good Evening';
    }
    function renderCards() {
        return DEPARTMENTS.map(function (dept, i) {
            var isLive = dept.live;
            return `
        <div class="dept-card ${isLive ? 'active-card' : ''}" data-index="${i}">
          <div class="dept-icon">${dept.icon}</div>
          <div class="dept-name">${dept.name}</div>
          <span class="dept-badge ${isLive ? 'badge-live' : 'badge-soon'}">
            ${isLive ? 'Dashboard' : 'Coming Soon'}
          </span>
        </div>
      `;
        }).join('');
    }
    function render() {
        var app = document.getElementById('app');
        var page = document.createElement('div');
        page.id = 'page-home';
        page.className = 'page';
        page.innerHTML = `
      <div class="home-content">
        <div class="greeting">
          <h1>${getGreeting()}</h1>
          <p>Select a department to view its dashboard</p>
        </div>
        <div class="dept-grid">
          ${renderCards()}
        </div>
      </div>
    `;
        app.appendChild(page);
        // Bind click handlers
        page.querySelectorAll('.dept-card').forEach(function (card) {
            var idx = parseInt(card.dataset.index, 10);
            var dept = DEPARTMENTS[idx];
            if (dept.action) {
                card.addEventListener('click', dept.action);
            }
        });
    }
    // Initialize
    render();
    // Expose page module
    window.HomePage = {};
})();
