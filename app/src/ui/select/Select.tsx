import type { ReactNode } from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";

import styles from "./Select.module.css";

export type SelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

export type SelectProps = {
  label: string;
  name: string;
  value: string;
  options: readonly SelectOption[];
  onValueChange: (value: string) => void;
  disabled?: boolean;
  defaultOpen?: boolean;
};

export function Select({
  defaultOpen,
  disabled = false,
  label,
  name,
  onValueChange,
  options,
  value,
}: SelectProps): ReactNode {
  return (
    <SelectPrimitive.Root
      name={name}
      value={value}
      disabled={disabled}
      onValueChange={onValueChange}
      {...(defaultOpen === undefined ? {} : { defaultOpen })}
    >
      <SelectPrimitive.Trigger className={styles.trigger} aria-label={label}>
        <SelectPrimitive.Value />
        <SelectPrimitive.Icon className={styles.triggerIcon}>
          <CaretDownIcon aria-hidden="true" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          className={styles.content}
          position="popper"
          sideOffset={6}
        >
          <SelectPrimitive.Viewport className={styles.viewport}>
            {options.map((option) => (
              <SelectPrimitive.Item
                key={option.value}
                className={styles.item}
                value={option.value}
                disabled={option.disabled ?? false}
              >
                <SelectPrimitive.ItemIndicator className={styles.indicator}>
                  <CheckIcon aria-hidden="true" />
                </SelectPrimitive.ItemIndicator>
                <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
