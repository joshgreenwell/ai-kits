import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';

// Use the same checked-in shadcn Select inside archived HTML documents. Keep
// the original control as the report's data/event contract, hidden from users.
for (const original of document.querySelectorAll<HTMLSelectElement>('select')) {
  if (original.multiple) continue;
  const container = document.createElement('span');
  container.dataset.observatorySelect = '';
  const label = original.getAttribute('aria-label') || Array.from(original.labels ?? []).map(item => {
    const copy = item.cloneNode(true) as HTMLElement;
    copy.querySelectorAll('select').forEach(control => control.remove());
    return copy.textContent?.trim();
  }).join(' ') || 'Report filter';
  const controlId = `${original.id || 'report-select'}-shadcn-${document.querySelectorAll('[data-observatory-select]').length}`;
  for (const item of original.labels ?? []) {
    if (item.htmlFor === original.id || item.contains(original)) item.htmlFor = controlId;
  }
  original.after(container);
  const root = createRoot(container);

  function DocumentSelect() {
    const [, refresh] = useState(0);
    useEffect(() => {
      const sync = () => refresh(value => value + 1);
      const observer = new MutationObserver(sync);
      observer.observe(original, { attributes: true, childList: true, subtree: true });
      original.addEventListener('change', sync);
      return () => { observer.disconnect(); original.removeEventListener('change', sync); };
    }, []);
    const selected = original.selectedIndex;
    const options = Array.from(original.options);
    return <Select disabled={original.disabled} value={selected < 0 ? '' : `option-${selected}`} onValueChange={value => {
      const index = Number(value.slice(7));
      if (!options[index]) return;
      original.selectedIndex = index;
      original.dispatchEvent(new Event('input', { bubbles: true }));
      original.dispatchEvent(new Event('change', { bubbles: true }));
    }}>
      <SelectTrigger id={controlId} aria-label={label}><SelectValue placeholder="Choose an option"/></SelectTrigger>
      <SelectContent position="popper" align="start">{options.map((option, index) => <SelectItem key={index} value={`option-${index}`} disabled={option.disabled || (option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled)}>{option.label}</SelectItem>)}</SelectContent>
    </Select>;
  }

  flushSync(() => root.render(<DocumentSelect/>));
  original.dataset.observatoryNativeSelect = '';
  original.hidden = true;
  original.setAttribute('aria-hidden', 'true');
  original.tabIndex = -1;
}
