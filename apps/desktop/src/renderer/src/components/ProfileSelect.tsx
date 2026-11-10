import type { Profile } from '@shared/types'
import { MenuSelect } from './MenuSelect'
import { ProfileIcon } from './ProfileIcon'

/**
 * Dropdown of launch profiles with their icons (a terminal's or an AI agent's panel).
 */
export function ProfileSelect({
  value,
  choices,
  placeholder,
  title,
  onChange
}: {
  value?: string
  choices: Profile[]
  placeholder: string
  title?: string
  onChange: (profileId: string) => void
}): React.JSX.Element {
  return (
    <MenuSelect
      value={value}
      choices={choices.map((p) => ({ value: p.id, label: p.name, icon: <ProfileIcon profile={p} />, title: p.source }))}
      placeholder={placeholder}
      title={title}
      empty="Nothing installed"
      onChange={onChange}
    />
  )
}
