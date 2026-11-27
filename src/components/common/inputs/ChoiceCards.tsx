import { useId, type ReactNode } from 'react';

export interface ChoiceCardOption {
  value: string;
  label: string;
  icon: ReactNode;
  description?: string;
  disabled?: boolean;
}

/** Native radio behavior with the application's shared button and surface recipes. */
export function ChoiceCards({ label, value, options, onChange, disabled = false }: {
  label: string; value: string; options: ChoiceCardOption[]; onChange: (value: string) => void; disabled?: boolean;
}) {
  const name = useId();
  return <fieldset className="choice-cards" aria-label={label} disabled={disabled}>
    {options.map(option => <label key={option.value}
      className={`btn choice-card${value === option.value ? ' is-selected' : ''}${option.disabled ? ' is-disabled' : ''}`}>
      <input autoComplete="off" type="radio" name={name} value={option.value}
        checked={value === option.value} disabled={option.disabled} onChange={() => onChange(option.value)} />
      <span className="choice-card-icon" aria-hidden="true">{option.icon}</span>
      <strong>{option.label}</strong>
      {option.description && <span className="choice-card-description">{option.description}</span>}
    </label>)}
  </fieldset>;
}
