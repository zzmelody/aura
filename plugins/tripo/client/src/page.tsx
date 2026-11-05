import React from 'react';
import { definePage, type Context } from '@aura/plugin-ui';
import { TripoSettingsPage } from './TripoSettingsPage.tsx';
import styles from './settings.css?inline';

export const inject = ['auraWorkbench'];

export function apply(ctx: Context) {
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.auraPlugin = 'aura.tripo';
    style.textContent = styles;
    document.head.append(style);
    return () => style.remove();
  });
  ctx.auraWorkbench.page(
    definePage({
      id: 'settings',
      title: 'Tripo 设置',
      description: '配置 Tripo 3D 连接和付费额度。',
      icon: 'Box',
      render: (props) => <TripoSettingsPage key={props.endpoint} {...props} />,
    }),
  );
}
