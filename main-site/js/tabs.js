// Tabs: a role="tablist" of buttons, each with aria-controls naming its
// role="tabpanel". One panel shows at a time; the arrow keys, Home and End
// move between the tabs that are not hidden, and the open tab is kept in
// the address (#signups) so a reload or a shared link opens it again.
//
// A tab is hidden with its button's hidden attribute (a section this role
// may not use); the list itself hides while only one tab is left.

export function startTabs(tablist, { onSelect } = {}) {
  const tabs = () => [...tablist.querySelectorAll('[role="tab"]')];
  const shown = () => tabs().filter((tab) => !tab.hidden);
  const panelOf = (tab) => document.getElementById(tab.getAttribute('aria-controls'));

  function select(tab, { focus = false, remember = true } = {}) {
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
    if (remember) {
      history.replaceState(null, '', `#${tab.dataset.tab}`);
    }
    if (onSelect) {
      onSelect(tab.dataset.tab);
    }
  }

  function byName(name) {
    return shown().find((tab) => tab.dataset.tab === name);
  }

  tablist.addEventListener('click', (event) => {
    const tab = event.target.closest('[role="tab"]');
    if (tab) {
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
      select(next, { focus: true });
    }
  });

  // After tabs are shown or hidden: the list shows only with two or more,
  // and the tab named in the address (or the open one, or the first) opens.
  function refresh() {
    const visible = shown();
    tablist.hidden = visible.length < 2;
    let wanted = byName(location.hash.slice(1));
    if (!wanted) {
      wanted = visible.find((tab) => tab.getAttribute('aria-selected') === 'true');
    }
    if (!wanted) {
      wanted = visible[0];
    }
    if (wanted) {
      select(wanted, { remember: false });
    }
  }

  // A link to another tab on the same page (/manage#signups) opens it.
  window.addEventListener('hashchange', () => {
    const tab = byName(location.hash.slice(1));
    if (tab) {
      select(tab, { remember: false });
    }
  });

  refresh();
  return {
    refresh,
    open(name) {
      const tab = byName(name);
      if (tab) {
        select(tab);
      }
    },
  };
}
