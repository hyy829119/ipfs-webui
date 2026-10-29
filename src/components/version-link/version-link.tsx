import React from 'react'
import { parseAgentVersion } from '../../lib/parse-agent-version'

// formats an ipfs agentVersion string from /kubo/0.14.0/desktop to kubo v0.14.0 desktop
const VersionLink: React.FC<{ agentVersion: string }> = ({ agentVersion }) => {
  if (!agentVersion) return <span>Unknown</span>
  const { name, version, suffix } = parseAgentVersion(agentVersion)

  return (
    <span>
      <span>{name}</span>
      {version ? <span> v{version}</span> : ''}
      {suffix ? <span> {suffix}</span> : ''}
    </span>
  )
}

export default VersionLink
