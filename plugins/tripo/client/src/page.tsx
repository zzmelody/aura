import React from 'react';
import { definePage, type Context } from '@aura/plugin-ui';
import { TripoSettingsPage } from './TripoSettingsPage.tsx';
import styles from './settings.css?inline';
import { translations } from './messages.ts';

export const inject = ['auraWorkbench'];

export function apply(ctx: Context) {
  ctx.auraWorkbench.translations(translations);
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
      titleKey: 'title',
      description: '配置 Tripo 3D 连接和付费额度。',
      descriptionKey: 'description',
      icon: 'Box',
      render: (props) => <TripoSettingsPage key={props.endpoint} {...props} />,
    }),
  );
}
