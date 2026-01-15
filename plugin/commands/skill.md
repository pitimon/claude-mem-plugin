# /skill - Skill Library Management

You are a skill library manager. The user wants to manage installable workflow skills.

## Input
The user provided: `$ARGUMENTS`

## Task

Parse the input to determine the subcommand and execute it:

### Subcommands

1. **`/skill list`** - List available and installed skills
2. **`/skill install <name>`** - Install a skill
3. **`/skill uninstall <name>`** - Uninstall a skill
4. **`/skill search <query>`** - Search for skills
5. **`/skill show <name>`** - Show skill details
6. **`/skill` or `/skill help`** - Show help

## Implementation

### Paths
- **Available skills:** `~/.claude/plugins/marketplaces/thedotmack/plugin/skills/`
- **Installed skills:** `~/.claude-mem/skills/`
- **Registry:** `~/.claude/plugins/marketplaces/thedotmack/plugin/skills/registry.json`

### 1. `/skill list`

```bash
# List available skills from registry
cat ~/.claude/plugins/marketplaces/thedotmack/plugin/skills/registry.json

# List installed skills
ls ~/.claude-mem/skills/ 2>/dev/null || echo "No skills installed"
```

**Output format:**
```
## Available Skills

| Name | Category | Description |
|------|----------|-------------|
| aws-cdk | cloud | AWS CDK best practices |
| tdd | testing | Test-driven development |
| code-review | general | Code review guidelines |

## Installed Skills
- aws-cdk (v1.0.0)
- tdd (v1.0.0)

Use `/skill install <name>` to install a skill.
```

### 2. `/skill install <name>`

```bash
# Check if skill exists
SKILL_PATH=~/.claude/plugins/marketplaces/thedotmack/plugin/skills/<name>
if [ -d "$SKILL_PATH" ]; then
  # Create installed skills directory
  mkdir -p ~/.claude-mem/skills

  # Copy skill to installed location
  cp -r "$SKILL_PATH" ~/.claude-mem/skills/

  echo "Skill '<name>' installed successfully!"
else
  echo "Error: Skill '<name>' not found"
fi
```

### 3. `/skill uninstall <name>`

```bash
INSTALLED_PATH=~/.claude-mem/skills/<name>
if [ -d "$INSTALLED_PATH" ]; then
  rm -rf "$INSTALLED_PATH"
  echo "Skill '<name>' uninstalled successfully!"
else
  echo "Error: Skill '<name>' is not installed"
fi
```

### 4. `/skill search <query>`

```bash
# Search in registry
cat ~/.claude/plugins/marketplaces/thedotmack/plugin/skills/registry.json | \
  jq '.skills[] | select(.name | contains("<query>") or .description | contains("<query>"))'
```

### 5. `/skill show <name>`

```bash
# Show skill details
cat ~/.claude/plugins/marketplaces/thedotmack/plugin/skills/<name>/SKILL.md
```

## Help Output (show for `/skill` or `/skill help`)

```
/skill - Manage installable workflow skills

Usage:
  /skill list                  List available and installed skills
  /skill install <name>        Install a skill
  /skill uninstall <name>      Uninstall a skill
  /skill search <query>        Search for skills
  /skill show <name>           Show skill details
  /skill help                  Show this help

Available Skills:
  aws-cdk      - AWS CDK best practices and patterns
  tdd          - Test-driven development methodology
  code-review  - Code review guidelines and checklists
  docker       - Docker and containerization best practices
  kubernetes   - Kubernetes deployment patterns

Examples:
  /skill list
  /skill install aws-cdk
  /skill show tdd
  /skill search cloud
```

## Using Installed Skills

When a skill is installed, it provides guidelines that enhance Claude's responses.

To use an installed skill, reference it in your prompt:
```
"Using the aws-cdk skill, help me create a Lambda function"
"Apply the tdd skill while implementing this feature"
```

Claude will read the skill from `~/.claude-mem/skills/<name>/SKILL.md` and apply its guidelines.

## Important Notes

- Execute the bash commands - don't just explain
- Create directories if they don't exist
- Show success/error messages clearly
- After install, suggest how to use the skill
