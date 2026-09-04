import type { ComponentProps } from 'react';
import {
  IconArrowsSort,
  IconCheck,
  IconChevronLeft,
  IconCircleX,
  IconCopy,
  IconDots,
  IconLogout,
  IconPencil,
  IconPlus,
  IconShare,
  IconShoppingCart,
  IconTrash,
} from '@tabler/icons-react';

export const ICONS = {
  plus: IconPlus,
  back: IconChevronLeft,
  dots: IconDots,
  trash: IconTrash,
  check: IconCheck,
  share: IconShare,
  copy: IconCopy,
  edit: IconPencil,
  clear: IconCircleX,
  leave: IconLogout,
  sort: IconArrowsSort,
  cart: IconShoppingCart,
} as const;

export type IconName = keyof typeof ICONS;
export type IconProps = ComponentProps<(typeof ICONS)[IconName]>;

interface AppIconProps extends Omit<IconProps, 'size'> {
  name: IconName;
  size?: number;
}

export function Icon({ name, size = 24, ...props }: AppIconProps) {
  const IconComponent = ICONS[name];
  return <IconComponent size={size} stroke={2} aria-hidden="true" {...props} />;
}
