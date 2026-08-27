import { useId, type InputHTMLAttributes, type KeyboardEvent, type ReactNode } from "react";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";

import { IconButton } from "../button/Button";
import styles from "./SearchField.module.css";

export type SearchFieldProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "id" | "name" | "onChange" | "onKeyDown" | "type" | "value"
> & {
  label: string;
  name: string;
  placeholder: string;
  value: string;
  onValueChange: (value: string) => void;
  shortcut?: string;
};

/** 紧凑但完整标注的搜索输入；清除与 Escape 共用同一个显式值变更入口。 */
export function SearchField({
  disabled,
  label,
  name,
  onValueChange,
  placeholder,
  shortcut,
  value,
  ...props
}: SearchFieldProps): ReactNode {
  const id = useId();

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== "Escape" || value.length === 0) return;
    event.preventDefault();
    onValueChange("");
    event.currentTarget.focus();
  };

  return (
    <div className={styles.field}>
      <label className={styles.visuallyHidden} htmlFor={id}>{label}</label>
      <MagnifyingGlassIcon className={styles.searchIcon} aria-hidden="true" />
      <input
        {...props}
        id={id}
        type="search"
        name={name}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => onValueChange(event.currentTarget.value)}
        onKeyDown={handleKeyDown}
      />
      {value.length === 0 ? null : (
        <IconButton
          className={styles.clearButton}
          size="compact"
          label="清除搜索"
          icon={<XIcon />}
          disabled={disabled}
          onClick={() => onValueChange("")}
        />
      )}
      {shortcut === undefined ? null : (
        <kbd className={styles.shortcut} aria-hidden="true">
          {shortcut}
        </kbd>
      )}
    </div>
  );
}
