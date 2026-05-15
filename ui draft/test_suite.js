/**
 * RhemaCast UI Draft Verification Suite
 * Run this in the browser console on any page to verify basic layout and navigation integrity.
 */

const RhemaTest = {
    verifyNavigation: () => {
        const links = document.querySelectorAll('.chrome-tab');
        const expectedPages = [
            'presentation.html',
            'library.html',
            'history.html',
            'settings.html',
            'extensions.html'
        ];
        
        let allValid = true;
        links.forEach(link => {
            const href = link.getAttribute('href');
            if (!expectedPages.includes(href)) {
                console.error(`❌ Unexpected link: ${href}`);
                allValid = false;
            }
        });
        
        if (allValid) console.log('✅ Global navigation links are valid.');
    },

    verifyActiveState: () => {
        const currentPath = window.location.pathname.split('/').pop();
        const activeTab = document.querySelector('.chrome-tab.active');
        
        if (!activeTab) {
            console.error('❌ No active tab found.');
            return;
        }

        const activeHref = activeTab.getAttribute('href');
        if (activeHref === currentPath) {
            console.log(`✅ Active tab correctly set to: ${activeHref}`);
        } else {
            console.error(`❌ Active tab mismatch! Found: ${activeHref}, Expected: ${currentPath}`);
        }
    },

    verifyGlobalStyles: () => {
        const hasGlobalCss = Array.from(document.querySelectorAll('link'))
            .some(l => l.getAttribute('href') === 'global.css');
        
        if (hasGlobalCss) {
            console.log('✅ global.css is correctly linked.');
        } else {
            console.error('❌ global.css NOT found.');
        }
    },

    runAll: function() {
        console.group('RhemaCast UI Draft Test Suite');
        this.verifyGlobalStyles();
        this.verifyNavigation();
        this.verifyActiveState();
        console.groupEnd();
    }
};

// Auto-run if injected
// RhemaTest.runAll();
