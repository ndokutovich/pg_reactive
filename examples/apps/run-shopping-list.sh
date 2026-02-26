#!/usr/bin/env bash
# Run "What to Buy" shopping list demo apps
# Usage:
#   ./run-shopping-list.sh all        # Start all 5 apps
#   ./run-shopping-list.sh vanilla    # Start vanilla only
#   ./run-shopping-list.sh react      # Start React only
#   ./run-shopping-list.sh vue        # Start Vue only
#   ./run-shopping-list.sh svelte     # Start Svelte only
#   ./run-shopping-list.sh angular    # Start Angular only
#   ./run-shopping-list.sh stop       # Stop all running apps
#   ./run-shopping-list.sh status     # Show running apps

set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
PIDFILE="$DIR/.shopping-list-pids"

# Port assignments
PORT_VANILLA=3090
PORT_REACT=3091
PORT_VUE=3092
PORT_SVELTE=3093
PORT_ANGULAR=3094

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${GREEN}[+]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[x]${NC} $1"; }

check_serve() {
  if ! command -v npx &>/dev/null; then
    err "npx not found. Install Node.js first."
    exit 1
  fi
}

start_app() {
  local name=$1 port=$2 dir=$3
  # Check if port is already in use
  if curl -s -o /dev/null -w '' "http://127.0.0.1:$port/" 2>/dev/null; then
    warn "$name already running on port $port"
    return
  fi
  log "Starting $name on http://127.0.0.1:$port ..."
  cd "$dir" && npx -y serve -l "$port" -s . --no-clipboard > /dev/null 2>&1 &
  local pid=$!
  echo "$name=$pid=$port" >> "$PIDFILE"
  sleep 1
  if curl -s -o /dev/null -w '' "http://127.0.0.1:$port/" 2>/dev/null; then
    log "$name ready at ${CYAN}http://127.0.0.1:$port${NC}"
  else
    warn "$name starting (may need a moment)..."
  fi
}

stop_all() {
  if [ ! -f "$PIDFILE" ]; then
    warn "No running apps found."
    return
  fi
  while IFS='=' read -r name pid port; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      log "Stopped $name (PID $pid, port $port)"
    fi
  done < "$PIDFILE"
  rm -f "$PIDFILE"
  log "All apps stopped."
}

show_status() {
  echo ""
  echo -e "${CYAN}What to Buy — Shopping List Apps${NC}"
  echo "================================"
  local running=0
  for entry in "Vanilla=$PORT_VANILLA" "React=$PORT_REACT" "Vue=$PORT_VUE" "Svelte=$PORT_SVELTE" "Angular=$PORT_ANGULAR"; do
    local name="${entry%%=*}"
    local port="${entry##*=}"
    if curl -s -o /dev/null -w '' "http://127.0.0.1:$port/" 2>/dev/null; then
      echo -e "  ${GREEN}●${NC} $name      http://127.0.0.1:$port"
      running=$((running + 1))
    else
      echo -e "  ${RED}○${NC} $name      (not running)"
    fi
  done
  echo ""
  if [ $running -gt 0 ]; then
    echo -e "  ${GREEN}$running app(s) running${NC}. Use ${YELLOW}./run-shopping-list.sh stop${NC} to stop all."
  fi
  echo ""
}

start_vanilla() { start_app "Vanilla"  "$PORT_VANILLA"  "$DIR/shopping-list"; }
start_react()   { start_app "React"    "$PORT_REACT"    "$DIR/shopping-list-react/dist"; }
start_vue()     { start_app "Vue"      "$PORT_VUE"      "$DIR/shopping-list-vue/dist"; }
start_svelte()  { start_app "Svelte"   "$PORT_SVELTE"   "$DIR/shopping-list-svelte/dist"; }
start_angular() { start_app "Angular"  "$PORT_ANGULAR"  "$DIR/shopping-list-angular/dist/browser"; }

start_all() {
  echo ""
  echo -e "${CYAN}Starting all What to Buy apps...${NC}"
  echo ""
  start_vanilla
  start_react
  start_vue
  start_svelte
  start_angular
  echo ""
  show_status
}

# --- Main ---
check_serve

case "${1:-all}" in
  vanilla)  start_vanilla; show_status ;;
  react)    start_react;   show_status ;;
  vue)      start_vue;     show_status ;;
  svelte)   start_svelte;  show_status ;;
  angular)  start_angular; show_status ;;
  all)      start_all ;;
  stop)     stop_all ;;
  status)   show_status ;;
  *)
    echo "Usage: $0 {all|vanilla|react|vue|svelte|angular|stop|status}"
    exit 1
    ;;
esac
