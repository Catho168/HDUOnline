/** Shadow DOM 宿主：所有扩展 UI 挂载在 body 直子节点的开放 Shadow Root 内。 */

import { HOST_ELEMENT_ID } from '@/core/shared/constants';
import { UI_CSS } from './styles';

let styleInjected = false;

export interface UiHost {
  host: HTMLElement;
  shadow: ShadowRoot;
  container: HTMLElement;
}

export function ensureUiHost(): UiHost {
  let host = document.getElementById(HOST_ELEMENT_ID);
  if (!host) {
    host = document.createElement('div');
    host.id = HOST_ELEMENT_ID;
    // 宿主本身不占布局；内部元素使用 position: fixed
    host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483000; pointer-events: none;';
    document.body.appendChild(host);
  }
  const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
  if (!styleInjected || !shadow.querySelector('style[data-hdu-ui]')) {
    const style = document.createElement('style');
    style.setAttribute('data-hdu-ui', '1');
    style.textContent = UI_CSS;
    shadow.appendChild(style);
    styleInjected = true;
  }
  let container = shadow.querySelector<HTMLElement>('#hdu-ui-root');
  if (!container) {
    container = document.createElement('div');
    container.id = 'hdu-ui-root';
    container.style.cssText = 'position: fixed; inset: 0; pointer-events: none;';
    shadow.appendChild(container);
  }
  return { host, shadow, container };
}

export function removeUiHost(): void {
  document.getElementById(HOST_ELEMENT_ID)?.remove();
  styleInjected = false;
}
