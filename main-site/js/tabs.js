// Tabs: a role="tablist" of buttons, each with aria-controls naming its
// role="tabpanel". One panel shows at a time; the arrow keys, Home and End
// move between the tabs that are not hidden, and the open tab is kept in
// the address (#filter) so a reload or a shared link opens it again, or
// kept out of it with hideHash (below).
//
// A tab is hidden with its button's hidden attribute (a section this role
// may not use); the list itself hides while only one tab is left.
//
// Each selection sends a bubbling "tabchange" event from the tablist.
//
// useHash: false leaves the address alone, for tabs inside a tab (the edit
// form's sections inside /manage's Manage event tab).
//
// hideHash: a link with a tab's name (/account#profile) still opens that
// tab, but the name is taken off the address bar at once and never written
// there; the open tab is kept for this browser tab (sessionStorage) instead,
// so a reload opens it again. A tab that opens only because the kept one is
// not shown yet (a staff tool's tab, before its section loads) is not kept,
// so the later refresh() still finds the kept one.

// The tab kept for this page with hideHash, or null.
function keptTab(key) {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function keepTab(key, name) {
  try {
    sessionStorage.setItem(key, name);
  } catch {
    // Storage blocked: a reload opens the first tab.
  }
}

// Takes the #name off the address, leaving the path and the query.
function dropHash() {
  if (location.hash) {
    history.replaceState(history.state, '', location.pathname + location.search);
  }
}

export function startTabs(tablist, { onSelect, useHash = true, hideHash = false } = {}) {
  const storageKey = `tabs:${location.pathname}:${tablist.id}`;
  // With hideHash, the tab the address named on arrival, until it opens.
  let linked = null;
  if (useHash && hideHash) {
    if (location.hash.length > 1) {
      linked = location.hash.slice(1);
    }
    dropHash();
  }
  const tabs = () => [...tablist.querySelectorAll('[role="tab"]')];
  const shown = () => tabs().filter((tab) => !tab.hidden);
  const panelOf = (tab) => document.getElementById(tab.getAttribute('aria-controls'));

  // remember: the tab is put in the address, or kept with hideHash.
  // keep: with hideHash, kept even though remember is false.
  function select(tab, { focus = false, remember = true, keep = remember } = {}) {
    for (const each of tabs()) {
      const selected = each === tab;
      each.setAttribute('aria-selected', String(selected));
      each.tabIndex = -1;
      if (selected) {
        each.tabIndex = 0;
      }
      panelOf(each).hidden = !selected;
    }
    if (focus) {
      tab.focus();
    }
    if (remember && useHash && !hideHash) {
      history.replaceState(null, '', `#${tab.dataset.tab}`);
    }
    if (keep && useHash && hideHash) {
      keepTab(storageKey, tab.dataset.tab);
    }
    if (onSelect) {
      onSelect(tab.dataset.tab);
    }
    // For the page tours (js/tour.js): a tab opened may have one of its own.
    tablist.dispatchEvent(new CustomEvent('tabchange', { bubbles: true, detail: { tab: tab.dataset.tab } }));
  }

  function byName(name) {
    return shown().find((tab) => tab.dataset.tab === name);
  }

  tablist.addEventListener('click', (event) => {
    const tab = event.target.closest('[role="tab"]');
    if (tab) {
      linked = null;
      select(tab);
    }
  });
  tablist.addEventListener('keydown', (event) => {
    const visible = shown();
    const index = visible.indexOf(document.activeElement);
    if (index < 0) {
      return;
    }
    let next = null;
    if (event.key === 'ArrowRight') {
      next = visible[(index + 1) % visible.length];
    } else if (event.key === 'ArrowLeft') {
      next = visible[(index - 1 + visible.length) % visible.length];
    } else if (event.key === 'Home') {
      next = visible[0];
    } else if (event.key === 'End') {
      next = visible[visible.length - 1];
    }
    if (next) {
      event.preventDefault();
      linked = null;
      select(next, { focus: true });
    }
  });

  // After tabs are shown or hidden: the list shows only with two or more,
  // and the tab named in the address (or the open one, or the first) opens.
  function refresh() {
    const visible = shown();
    tablist.hidden = visible.length < 2;
    let wanted;
    // Kept with hideHash: the tab a link named, now that it opens.
    let keep = false;
    if (useHash && hideHash) {
      wanted = byName(linked);
      if (wanted) {
        linked = null;
        keep = true;
      } else {
        wanted = byName(keptTab(storageKey));
      }
    } else if (useHash) {
      wanted = byName(location.hash.slice(1));
    }
    if (!wanted) {
      wanted = visible.find((tab) => tab.getAttribute('aria-selected') === 'true');
    }
    if (!wanted) {
      wanted = visible[0];
    }
    if (wanted) {
      select(wanted, { remember: false, keep });
    }
  }

  // A link to another tab on the same page (/manage#filter) opens it.
  if (useHash) {
    window.addEventListener('hashchange', () => {
      const tab = byName(location.hash.slice(1));
      if (hideHash) {
        dropHash();
      }
      if (tab) {
        linked = null;
        select(tab, { remember: false, keep: true });
      }
    });
  }

  refresh();
  return {
    refresh,
    open(name) {
      const tab = byName(name);
      if (tab) {
        select(tab);
      }
    },
    // The open tab's name.
    current() {
      const tab = shown().find((each) => each.getAttribute('aria-selected') === 'true');
      if (tab) {
        return tab.dataset.tab;
      }
      return null;
    },
  };
}
