/**
 * =============================================================================
 * MacJet - Glassmorphism System Monitor Widget for Übersicht
 * =============================================================================
 *
 * Description:
 *   A beautiful glassmorphism desktop widget that displays real-time system
 *   information on your macOS desktop. Designed for Übersicht widget framework.
 *
 * Features:
 *   - CPU usage with thermal throttling indicator
 *   - Memory usage (accounts for purgeable memory)
 *   - Disk usage with APFS purgeable space (accurate reporting)
 *   - Battery status, health, cycle count, and time estimates (shows "calculating..." when pending)
 *   - Power monitoring: adapter usage/capacity, charging power, discharge rate
 *   - Network: WiFi SSID/IP, Ethernet IP, Tailscale VPN status
 *   - Bluetooth device battery levels (Magic Mouse, Keyboard, etc.)
 *   - Battery temperature monitoring
 *   - Gradient progress bars with glow effects
 *   - Click to expand/collapse sections for additional details
 *   - Persistent expand/collapse state via localStorage
 *   - Configurable scale (zoom) and screen position
 *   - System uptime display
 *
 * Technical Details:
 *   - Uses embedded Python script for data collection via macOS APIs
 *   - Queries: ioreg, pmset, sysctl, vm_stat, system_profiler, top
 *   - Swift code for accurate APFS disk space (volumeAvailableCapacityForImportantUsage)
 *   - Tailscale CLI integration for VPN status
 *   - Handles unsigned 64-bit to signed conversion for battery amperage
 *   - ChargingCurrent × ChargingVoltage for accurate charging power
 *
 * Requirements:
 *   - macOS 10.15 (Catalina) or later
 *   - Übersicht (https://tracesof.net/uebersicht/)
 *   - Python 3 (included with macOS)
 *   - Xcode Command Line Tools (for Swift disk calculation)
 *   - Optional: Tailscale app for VPN status
 *   - Optional: osx-cpu-temp for CPU temperature
 *
 * Installation:
 *   1. Install Übersicht from https://tracesof.net/uebersicht/
 *   2. Copy this folder to ~/Library/Application Support/Übersicht/widgets/
 *   3. Rename folder to 'macjet' if desired
 *   4. Übersicht will automatically load the widget
 *
 * Configuration:
 *   Edit the CONFIGURATION section below to customize:
 *   - refreshFrequency: Update interval in milliseconds (default: 5000)
 *   - SCALE: Widget zoom factor (1.0 = 100%, 1.2 = 120%, 0.8 = 80%)
 *   - POSITION: Screen corner ('bottom-left', 'bottom-right', 'top-left', 'top-right')
 *
 * Author:  B4E SRL - David Baldwin
 * License: MIT
 * Version: 2.3.6
 * Date:    2025-11-29
 *
 * Repository: https://github.com/dbn-b4e/MacJet
 *
 * =============================================================================
 */

// =============================================================================
// CONFIGURATION
// =============================================================================

// Refresh interval in milliseconds
export const refreshFrequency = 5000;

// Scale factor: 1.0 = 100%, 1.2 = 120%, 0.8 = 80%
const SCALE = 1.0;

// Version
const VERSION = '2.3.6';

// Position: 'bottom-left', 'bottom-right', 'top-left', 'top-right'
const POSITION = 'bottom-left';

// Data collection command
export const command = `
python3 -W ignore << 'PYTHON_SCRIPT'
import subprocess
import re
import json
import time

def run_cmd(cmd):
    try:
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=5)
        return result.stdout
    except:
        return ""

def parse_ioreg_battery():
    output = run_cmd("ioreg -rn AppleSmartBattery")
    info = {}
    patterns = {
        'current_capacity_mah': r'"CurrentCapacity"\\s*=\\s*(\\d+)',
        'max_capacity_mah': r'"MaxCapacity"\\s*=\\s*(\\d+)',
        'design_capacity_mah': r'"DesignCapacity"=(\\d+)',
        'voltage_mv': r'"Voltage"\\s*=\\s*(\\d+)',
        'instant_amperage_ma': r'"InstantAmperage"\\s*=\\s*(-?\\d+)',
        'amperage_ma': r'"Amperage"\\s*=\\s*(-?\\d+)',
        'adapter_watts': r'"Watts"=(\\d+)',
        'adapter_voltage_mv': r'"AdapterVoltage"=(\\d+)',
        'adapter_current_ma': r'"Current"=(\\d+)',
        'system_power_mw': r'"SystemPowerIn"=(\\d+)',
        'charging_current_ma': r'"ChargingCurrent"=(\\d+)',
        'charging_voltage_mv': r'"ChargingVoltage"=(\\d+)',
        'cycle_count': r'"CycleCount"=(\\d+)',
    }
    for key, pattern in patterns.items():
        match = re.search(pattern, output)
        info[key] = int(match.group(1)) if match else 0
    match = re.search(r'"IsCharging"\\s*=\\s*(Yes|No)', output)
    info['is_charging'] = match.group(1) == 'Yes' if match else False
    match = re.search(r'"ExternalConnected"\\s*=\\s*(Yes|No)', output)
    info['external_connected'] = match.group(1) == 'Yes' if match else False
    return info

def parse_pmset():
    output = run_cmd("pmset -g batt")
    info = {}
    match = re.search(r'(\\d+)%', output)
    info['percentage'] = int(match.group(1)) if match else 0
    if 'charging' in output.lower() and 'discharging' not in output.lower():
        info['status'] = 'Charging'
    elif 'discharging' in output.lower():
        info['status'] = 'Discharging'
    elif 'charged' in output.lower():
        info['status'] = 'Full'
    else:
        info['status'] = 'AC'
    return info

def get_cpu_usage():
    output = run_cmd("top -l 1 -n 0 | grep 'CPU usage'")
    match = re.search(r'(\\d+\\.?\\d*)%\\s*user.*?(\\d+\\.?\\d*)%\\s*sys', output)
    return float(match.group(1)) + float(match.group(2)) if match else 0

def get_memory_info():
    output = run_cmd("sysctl -n hw.memsize")
    total_bytes = int(output.strip()) if output.strip().isdigit() else 16 * 1024**3
    output = run_cmd("vm_stat")
    pages = {}
    page_size = 16384
    for line in output.split('\\n'):
        if 'page size' in line.lower():
            match = re.search(r'(\\d+)', line)
            if match:
                page_size = int(match.group(1))
        match = re.match(r'(.+):\\s+(\\d+)', line)
        if match:
            pages[match.group(1).strip()] = int(match.group(2))
    free = pages.get('Pages free', 0) * page_size
    inactive = pages.get('Pages inactive', 0) * page_size
    speculative = pages.get('Pages speculative', 0) * page_size
    purgeable = pages.get('Pages purgeable', 0) * page_size
    available = free + inactive + speculative + purgeable
    used_bytes = total_bytes - available
    used_bytes = min(used_bytes, total_bytes)
    return {
        'total_gb': total_bytes / (1024**3),
        'used_gb': used_bytes / (1024**3),
        'used_pct': used_bytes / total_bytes * 100
    }

def get_disk_info():
    info = {'total_gb': 0, 'available_gb': 0, 'free_gb': 0, 'purgeable_gb': 0, 'used_pct': 0}
    import tempfile
    import os

    # Try Swift method first (accurate purgeable space, requires Xcode CLI tools)
    swift_code = '''
import Foundation
let u = URL(fileURLWithPath: "/")
let k: Set<URLResourceKey> = [.volumeTotalCapacityKey, .volumeAvailableCapacityKey, .volumeAvailableCapacityForImportantUsageKey]
let v = try! u.resourceValues(forKeys: k)
print("\\(v.volumeTotalCapacity!),\\(v.volumeAvailableCapacity!),\\(v.volumeAvailableCapacityForImportantUsage!)")
'''
    try:
        fd, path = tempfile.mkstemp(suffix='.swift')
        os.write(fd, swift_code.encode())
        os.close(fd)
        output = run_cmd(f"swift {path} 2>/dev/null")
        os.unlink(path)
        parts = output.strip().split(',')
        if len(parts) == 3:
            total = int(parts[0])
            free = int(parts[1])
            important = int(parts[2])
            purgeable = important - free
            info['total_gb'] = total / 1e9
            info['free_gb'] = free / 1e9
            info['available_gb'] = important / 1e9
            info['purgeable_gb'] = purgeable / 1e9
            info['used_pct'] = int((total - important) / total * 100)
            return info
    except:
        pass

    # Fallback: use df command (works without Xcode, no purgeable info)
    try:
        output = run_cmd("df -k / | tail -1")
        parts = output.split()
        if len(parts) >= 4:
            total_kb = int(parts[1])
            used_kb = int(parts[2])
            avail_kb = int(parts[3])
            info['total_gb'] = total_kb / 1e6
            info['free_gb'] = avail_kb / 1e6
            info['available_gb'] = avail_kb / 1e6
            info['purgeable_gb'] = 0
            info['used_pct'] = int(used_kb / total_kb * 100) if total_kb > 0 else 0
    except:
        pass
    return info

def get_bluetooth_devices():
    """Get battery levels for connected Bluetooth devices (keyboard, mouse, etc)"""
    devices = []
    output = run_cmd("ioreg -r -k BatteryPercent 2>/dev/null")

    # Parse product name and battery pairs
    lines = output.split('\\n')
    current_product = None
    for line in lines:
        if '"Product"' in line:
            match = re.search(r'"Product"\\s*=\\s*"([^"]+)"', line)
            if match:
                current_product = match.group(1)
        elif '"BatteryPercent"' in line and current_product:
            match = re.search(r'"BatteryPercent"\\s*=\\s*(\\d+)', line)
            if match:
                # Shorten common names
                name = current_product
                if 'Magic' in name and 'Mouse' in name:
                    name = 'Mouse'
                elif 'Magic' in name and 'Keyboard' in name:
                    name = 'Keyboard'
                elif 'Magic' in name and 'Trackpad' in name:
                    name = 'Trackpad'
                elif 'AirPods' in name:
                    name = 'AirPods'
                devices.append({'name': name, 'battery': int(match.group(1))})
                current_product = None

    return devices

def get_temps_and_fans():
    """Get battery temp (CPU/fan need sudo or external tools)"""
    info = {'battery_temp': 0, 'cpu_temp': 0, 'fan_speed': 0}

    # Battery temperature from ioreg (in deci-Kelvin, convert to Celsius)
    output = run_cmd('ioreg -rn AppleSmartBattery | grep Temperature')
    match = re.search(r'"Temperature"\\s*=\\s*(\\d+)', output)
    if match:
        # Value is in deci-Kelvin (e.g., 3050 = 305.0K = 31.85°C)
        temp_dk = int(match.group(1))
        info['battery_temp'] = round(temp_dk / 10 - 273.15, 1)

    # CPU temp - try multiple methods
    # Method 1: osx-cpu-temp (if installed via brew)
    cpu_output = run_cmd("osx-cpu-temp 2>/dev/null")
    if cpu_output.strip():
        match = re.search(r'([\\d.]+)', cpu_output)
        if match:
            info['cpu_temp'] = float(match.group(1))

    # Method 2: powermetrics (if sudo NOPASSWD configured)
    if info['cpu_temp'] == 0:
        pm_output = run_cmd("sudo -n powermetrics -s smc -i 1 -n 1 2>/dev/null | grep -i 'CPU die temperature'")
        if pm_output.strip():
            match = re.search(r'([\\d.]+)\\s*C', pm_output)
            if match:
                info['cpu_temp'] = float(match.group(1))

    # Fan speed from powermetrics (if sudo NOPASSWD configured)
    fan_output = run_cmd("sudo -n powermetrics -s smc -i 1 -n 1 2>/dev/null | grep -i 'Fan:'")
    if fan_output.strip():
        match = re.search(r'([\\d.]+)\\s*rpm', fan_output, re.IGNORECASE)
        if match:
            info['fan_speed'] = int(float(match.group(1)))

    return info

def get_network_info():
    info = {
        'wifi_ssid': 'Off',
        'wifi_ip': 'N/A',
        'ethernet_ip': 'N/A',
        'tailscale_ip': 'N/A',
        'tailscale_status': 'Offline'
    }

    # Get WiFi IP (en0 is usually WiFi on Mac)
    wifi_ip = run_cmd("ipconfig getifaddr en0 2>/dev/null")
    if wifi_ip.strip():
        info['wifi_ip'] = wifi_ip.strip()

    # Get WiFi SSID using system_profiler (airport is deprecated)
    ssid_output = run_cmd("system_profiler SPAirPortDataType 2>/dev/null | grep -A2 'Current Network Information:' | head -2 | tail -1 | sed 's/^[[:space:]]*//' | cut -d: -f1")
    if ssid_output.strip():
        info['wifi_ssid'] = ssid_output.strip()
    elif info['wifi_ip'] != 'N/A':
        info['wifi_ssid'] = 'Connected'

    # Get Ethernet IP (check common ethernet interfaces)
    for iface in ['en1', 'en2', 'en3', 'en4', 'en5', 'en6', 'en7', 'en8']:
        eth_ip = run_cmd(f"ipconfig getifaddr {iface} 2>/dev/null")
        if eth_ip.strip():
            info['ethernet_ip'] = eth_ip.strip()
            break

    # Get Tailscale status and IP - check status first
    ts_status = run_cmd("/Applications/Tailscale.app/Contents/MacOS/Tailscale status 2>/dev/null")
    if ts_status and 'Tailscale is stopped' not in ts_status:
        ts_ip = run_cmd("/Applications/Tailscale.app/Contents/MacOS/Tailscale ip -4 2>/dev/null")
        ts_ip_clean = ts_ip.strip().split(chr(10))[0] if ts_ip else ''
        if ts_ip_clean and len(ts_ip_clean) > 0 and ts_ip_clean[0].isdigit():
            info['tailscale_ip'] = ts_ip_clean
            info['tailscale_status'] = 'Online'

    return info

def get_uptime():
    output = run_cmd("sysctl -n kern.boottime")
    match = re.search(r'sec = (\\d+)', output)
    if match:
        boot_time = int(match.group(1))
        uptime_secs = int(time.time()) - boot_time
        days = uptime_secs // 86400
        hours = (uptime_secs % 86400) // 3600
        mins = (uptime_secs % 3600) // 60
        if days > 0:
            return f"{days}d {hours}h"
        elif hours > 0:
            return f"{hours}h {mins}m"
        else:
            return f"{mins}m"
    return "N/A"

def get_thermal():
    output = run_cmd("pmset -g therm")
    match = re.search(r'CPU_Speed_Limit\\s*=\\s*(\\d+)', output)
    return int(match.group(1)) if match else 100

# Gather data
battery = parse_ioreg_battery()
pmset = parse_pmset()
cpu = get_cpu_usage()
memory = get_memory_info()
disk = get_disk_info()
network = get_network_info()
uptime = get_uptime()
thermal = get_thermal()
bluetooth = get_bluetooth_devices()
temps = get_temps_and_fans()

# Power calculations
# Both Amperage and InstantAmperage are stored as unsigned 64-bit but represent signed values
amperage = battery['amperage_ma']
if amperage > 2**63:
    amperage = amperage - 2**64
instant_amp = battery['instant_amperage_ma']
if instant_amp > 2**63:
    instant_amp = instant_amp - 2**64

# System power calculation
if battery['external_connected']:
    # On AC: use actual battery Amperage * Voltage for real charging power
    # (ChargingCurrent from ChargerData can exceed actual charging)
    charge_w = amperage * battery['voltage_mv'] / 1000000 if amperage > 0 else 0
    # Total adapter power from SystemPowerIn
    adapter_total_w = battery['system_power_mw'] / 1000
    system_w = adapter_total_w - charge_w
else:
    # On battery: discharge power from InstantAmperage (negative) * Voltage
    system_w = abs(instant_amp) * battery['voltage_mv'] / 1000000
    charge_w = 0
    adapter_total_w = 0
health = (battery['max_capacity_mah'] / battery['design_capacity_mah'] * 100) if battery['design_capacity_mah'] > 0 else 0

# Get Mac's own time estimate from pmset
mac_time_str = ""
pmset_output = run_cmd("pmset -g batt")
time_match = re.search(r'(\\d+):(\\d+) remaining', pmset_output)
if time_match:
    mac_time_str = f"{time_match.group(1)}h {time_match.group(2)}m"

# Calculate our own estimate using actual battery Amperage
my_time_str = ""
time_label = ""
if battery['is_charging'] and amperage > 0:
    remaining_mah = battery['max_capacity_mah'] - battery['current_capacity_mah']
    mins = int(remaining_mah / amperage * 60)
    my_time_str = f"{mins // 60}h {mins % 60:02d}m"
    time_label = "to full"
elif not battery['external_connected'] and abs(instant_amp) > 0:
    mins = int(battery['current_capacity_mah'] / abs(instant_amp) * 60)
    my_time_str = f"{mins // 60}h {mins % 60:02d}m"
    time_label = "remaining"

# Check if sudo purge is available (passwordless) - just validate, don't run
can_purge = 'purge' in run_cmd("sudo -n -l 2>/dev/null")

data = {
    'cpu_pct': round(cpu, 1),
    'cpu_throttle': thermal,
    'memory_pct': round(memory['used_pct'], 0),
    'memory_used': round(memory['used_gb'], 1),
    'memory_total': round(memory['total_gb'], 0),
    'disk_pct': disk['used_pct'],
    'disk_total': round(disk['total_gb'], 0),
    'disk_free': round(disk['free_gb'], 0),
    'disk_purgeable': round(disk['purgeable_gb'], 0),
    'can_purge': can_purge,
    'battery_pct': pmset['percentage'],
    'battery_status': pmset['status'],
    'battery_health': round(health, 1),
    'battery_cycles': battery['cycle_count'],
    'battery_time_my': my_time_str,
    'battery_time_mac': mac_time_str,
    'battery_time_label': time_label,
    'is_charging': battery['is_charging'],
    'power_connected': battery['external_connected'],
    'adapter_watts': battery['adapter_watts'],
    'adapter_total_watts': round(adapter_total_w, 1),
    'system_watts': round(system_w, 1),
    'charge_watts': round(charge_w, 1),
    'wifi_ssid': network['wifi_ssid'],
    'wifi_ip': network['wifi_ip'],
    'ethernet_ip': network['ethernet_ip'],
    'tailscale_ip': network['tailscale_ip'],
    'tailscale_status': network['tailscale_status'],
    'uptime': uptime,
    'bluetooth_devices': bluetooth,
    'battery_temp': temps['battery_temp'],
    'cpu_temp': temps['cpu_temp'],
    'fan_speed': temps['fan_speed'],
}

print(json.dumps(data))
PYTHON_SCRIPT
`;

// Render the widget - simple pattern that works
export const render = ({ output, error }) => {
  // Handle error state
  if (error) {
    return <div style={styles.container}><span style={{color: '#ef4444'}}>Error: {error}</span></div>;
  }

  // Parse JSON data
  let data;
  try {
    data = JSON.parse(output);
  } catch (e) {
    return (
      <div style={styles.container}>
        <div style={styles.header}>
          <span style={styles.logo}>◆</span>
          <span style={styles.title}>MacJet</span>
        </div>
        <div style={{color: 'rgba(255,255,255,0.5)', textAlign: 'center', padding: '20px 0', fontSize: '10px'}}>
          Loading...
        </div>
      </div>
    );
  }

  // Get expanded state from localStorage (default: all expanded)
  const defaultExpanded = { cpu: true, memory: true, disk: true, battery: true, network: true };
  let expanded = { ...defaultExpanded };
  if (typeof window !== 'undefined') {
    try {
      const saved = localStorage.getItem('macjet-expanded');
      if (saved) expanded = { ...defaultExpanded, ...JSON.parse(saved) };
    } catch (e) {}
  }

  // Toggle section - saves to localStorage, updates on next data refresh
  const toggleSection = (section) => {
    expanded[section] = !expanded[section];
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem('macjet-expanded', JSON.stringify(expanded));
        // Update DOM directly for instant feedback
        const el = document.querySelector(`[data-section="${section}"]`);
        if (el) {
          el.style.display = expanded[section] ? 'flex' : 'none';
        }
        // Update expand icon
        const icon = document.querySelector(`[data-expand="${section}"]`);
        if (icon) {
          icon.textContent = expanded[section] ? '−' : '+';
        }
      } catch (e) {}
    }
  };

  // Progress bar component with gradient and glow
  const ProgressBar = ({ percent, color1, color2, glowColor }) => {
    const safePercent = Math.max(0, Math.min(100, percent || 0));
    return (
      <div style={styles.progressContainer}>
        <div style={styles.progressTrack}>
          <div
            style={{
              height: '100%',
              width: `${safePercent}%`,
              borderRadius: '3px',
              background: `linear-gradient(90deg, ${color1}, ${color2})`,
              boxShadow: `0 0 8px ${glowColor}, 0 0 4px ${glowColor}`,
              transition: 'width 0.5s ease',
            }}
          />
        </div>
        <span style={styles.progressValue}>{Math.round(safePercent)}%</span>
      </div>
    );
  };

  // Section header component
  const SectionHeader = ({ icon, title, section, extra }) => {
    const isExpanded = expanded[section];
    return (
      <div style={styles.sectionHeader} onClick={() => toggleSection(section)}>
        <span style={styles.sectionIcon}>{icon}</span>
        <span style={styles.sectionTitle}>{title}</span>
        {extra && <span style={styles.sectionExtra}>{extra}</span>}
        <span style={styles.expandIcon} data-expand={section}>{isExpanded ? '−' : '+'}</span>
      </div>
    );
  };

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <div style={styles.headerLeft}>
          <span style={styles.logo}>◆</span>
          <div style={styles.titleBlock}>
            <span style={styles.title}>MacJet</span>
            <span style={styles.version}>v{VERSION}</span>
          </div>
        </div>
        <span style={styles.uptime}>up {data.uptime}</span>
      </div>

      {/* CPU Section */}
      <div style={styles.section}>
        <SectionHeader
          icon="⚡"
          title="CPU"
          section="cpu"
          extra={data.cpu_throttle < 100 ? `${data.cpu_pct}% ⚠️${data.cpu_throttle}%` : `${data.cpu_pct}%`}
        />
        <ProgressBar
          percent={data.cpu_pct}
          color1="#06b6d4"
          color2="#8b5cf6"
          glowColor="rgba(139, 92, 246, 0.5)"
        />
        {(data.cpu_temp > 0 || data.fan_speed > 0) && (
          <div data-section="cpu" style={{...styles.details, display: expanded.cpu ? 'flex' : 'none'}}>
            {data.cpu_temp > 0 && <span>Temp: <span style={{color: data.cpu_temp > 80 ? '#ef4444' : data.cpu_temp > 60 ? '#f59e0b' : 'rgba(255,255,255,0.7)'}}>{data.cpu_temp}°C</span></span>}
            {data.cpu_temp > 0 && <span>Fan: {data.fan_speed > 0 ? data.fan_speed + ' RPM' : 'idle'}</span>}
          </div>
        )}
      </div>

      {/* Memory Section */}
      <div style={styles.section}>
        <SectionHeader
          icon="🧠"
          title="Memory"
          section="memory"
          extra={`${data.memory_used}/${data.memory_total}GB`}
        />
        <ProgressBar
          percent={data.memory_pct}
          color1="#10b981"
          color2="#06b6d4"
          glowColor="rgba(16, 185, 129, 0.5)"
        />
        {data.can_purge && (
          <div data-section="memory" style={{...styles.details, display: expanded.memory ? 'flex' : 'none'}}>
            <span
              style={{color: '#10b981', textDecoration: 'underline', cursor: 'pointer'}}
              onClick={(e) => {
                const el = e.target;
                el.textContent = 'Purging...';
                el.style.pointerEvents = 'none';
                const cmd = 'sudo purge 2>/dev/null || true';
                try { require('child_process').exec(cmd); } catch(err) {}
                setTimeout(() => { el.textContent = 'Purge RAM'; el.style.pointerEvents = 'auto'; }, 3000);
              }}
            >Purge RAM</span>
          </div>
        )}
      </div>

      {/* Disk Section */}
      <div style={styles.section}>
        <SectionHeader
          icon="💾"
          title="Disk"
          section="disk"
          extra={`${data.disk_free}/${data.disk_total}GB`}
        />
        <ProgressBar
          percent={data.disk_pct}
          color1="#f59e0b"
          color2="#ef4444"
          glowColor="rgba(245, 158, 11, 0.5)"
        />
        {data.disk_purgeable > 0 && (
          <div data-section="disk" style={{...styles.details, display: expanded.disk ? 'flex' : 'none'}}>
            <span>+{data.disk_purgeable}GB purgeable</span>
            {data.can_purge ? (
              <span
                style={{color: '#f59e0b', textDecoration: 'underline', cursor: 'pointer', marginLeft: '8px'}}
                onClick={(e) => {
                  const el = e.target;
                  el.textContent = 'Deleting...';
                  el.style.pointerEvents = 'none';
                  const cmd = 'for snap in $(tmutil listlocalsnapshots / 2>/dev/null | grep -v Snapshots); do sudo tmutil deletelocalsnapshots ${snap#com.apple.TimeMachine.} 2>/dev/null; done';
                  try { require('child_process').exec(cmd); } catch(err) {}
                  setTimeout(() => { el.textContent = 'Purge TM'; el.style.pointerEvents = 'auto'; }, 10000);
                }}
              >Purge TM</span>
            ) : (
              <a
                href="x-apple.systempreferences:com.apple.settings.Storage"
                style={{color: '#f59e0b', textDecoration: 'underline', cursor: 'pointer', marginLeft: '8px'}}
              >Manage</a>
            )}
          </div>
        )}
      </div>

      {/* Battery Section */}
      <div style={styles.section}>
        <SectionHeader
          icon={data.is_charging ? "⚡" : "🔋"}
          title="Battery"
          section="battery"
          extra={data.battery_status}
        />
        <ProgressBar
          percent={data.battery_pct}
          color1={data.battery_pct > 20 ? "#22c55e" : "#ef4444"}
          color2={data.battery_pct > 50 ? "#10b981" : "#f59e0b"}
          glowColor={data.battery_pct > 20 ? "rgba(34, 197, 94, 0.5)" : "rgba(239, 68, 68, 0.5)"}
        />
        <div data-section="battery" style={{...styles.details, display: expanded.battery ? 'flex' : 'none'}}>
          <span>Health: {data.battery_health}%</span>
          <span>Cycles: {data.battery_cycles}</span>
          {data.battery_temp > 0 && <span>Temp: {data.battery_temp}°C</span>}
          {data.battery_time_label && (
            <span>
              {data.battery_time_label === 'to full' ? 'Full' : 'Left'}: {data.battery_time_mac || data.battery_time_my || 'calculating...'}
            </span>
          )}
        </div>
        {/* Power info under battery */}
        <div style={{...styles.details, display: 'flex', marginTop: '6px'}}>
          {data.power_connected && (
            <span>
              Adapter: {data.adapter_total_watts}/{data.adapter_watts}W - <span style={{color: '#22c55e'}}>Charging {data.charge_watts}W</span>
            </span>
          )}
          {!data.power_connected && (
            <span>
              <span style={{color: '#f59e0b'}}>Discharge: {data.system_watts}W</span>
            </span>
          )}
        </div>
      </div>

      {/* Network Section */}
      <div style={styles.section}>
        <SectionHeader
          icon="📶"
          title="Network"
          section="network"
          extra={null}
        />
        <div style={styles.networkInfo}>
          <span style={styles.networkLabel}>WiFi:</span>
          <span style={{
            ...styles.networkValue,
            color: data.wifi_ssid !== 'Off' ? '#22c55e' : 'rgba(255,255,255,0.4)'
          }}>{data.wifi_ssid}</span>
          {data.wifi_ip !== 'N/A' && (
            <span style={{...styles.networkValue, marginLeft: '8px', color: 'rgba(255,255,255,0.5)'}}>{data.wifi_ip}</span>
          )}
        </div>
        <div style={styles.networkInfo}>
          <span style={styles.networkLabel}>Ethernet:</span>
          <span style={{
            ...styles.networkValue,
            color: data.ethernet_ip !== 'N/A' ? '#22c55e' : 'rgba(255,255,255,0.4)'
          }}>
            {data.ethernet_ip !== 'N/A' ? data.ethernet_ip : 'Off'}
          </span>
        </div>
        <div style={styles.networkInfo}>
          <span style={styles.networkLabel}>Tailscale:</span>
          <span style={{
            ...styles.networkValue,
            color: data.tailscale_status === 'Online' ? '#22c55e' : 'rgba(255,255,255,0.4)'
          }}>
            {data.tailscale_status === 'Online' ? data.tailscale_ip : 'Offline'}
          </span>
        </div>
      </div>

      {/* Bluetooth Devices */}
      {data.bluetooth_devices && data.bluetooth_devices.length > 0 && (
        <div style={styles.section}>
          <div style={styles.infoRow}>
            <span style={styles.infoIcon}>🔵</span>
            {data.bluetooth_devices.map((dev, i) => (
              <span key={i} style={styles.btDevice}>
                {dev.name}: <span style={{color: dev.battery > 20 ? '#22c55e' : '#ef4444'}}>{dev.battery}%</span>
                {i < data.bluetooth_devices.length - 1 && <span style={{margin: '0 8px', color: 'rgba(255,255,255,0.2)'}}>|</span>}
              </span>
            ))}
          </div>
        </div>
      )}

    </div>
  );
};

// Glassmorphism styles - darker background, wider, smaller font
const styles = {
  container: {
    fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Display", sans-serif',
    fontSize: '10px',
    color: '#ffffff',
    background: 'linear-gradient(135deg, rgba(0,0,0,0.7), rgba(0,0,0,0.85))',
    backdropFilter: 'blur(20px)',
    WebkitBackdropFilter: 'blur(20px)',
    borderRadius: '14px',
    padding: '14px 16px',
    width: '290px',
    border: '1px solid rgba(255,255,255,0.12)',
    boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
    transform: `scale(${SCALE})`,
    transformOrigin: POSITION.replace('-', ' '),
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: '14px',
    paddingBottom: '10px',
    borderBottom: '1px solid rgba(255,255,255,0.08)',
  },
  headerLeft: {
    display: 'flex',
    alignItems: 'center',
  },
  logo: {
    fontSize: '16px',
    marginRight: '8px',
    background: 'linear-gradient(135deg, #06b6d4, #8b5cf6)',
    WebkitBackgroundClip: 'text',
    WebkitTextFillColor: 'transparent',
  },
  titleBlock: {
    display: 'flex',
    flexDirection: 'column',
  },
  title: {
    fontSize: '14px',
    fontWeight: '600',
    lineHeight: '1.1',
  },
  version: {
    fontSize: '8px',
  },
  uptime: {
    fontSize: '9px',
    color: 'rgba(255,255,255,0.4)',
  },
  section: {
    marginBottom: '10px',
  },
  sectionHeader: {
    display: 'flex',
    alignItems: 'center',
    marginBottom: '6px',
    cursor: 'pointer',
    padding: '3px 0',
  },
  sectionIcon: {
    marginRight: '6px',
    fontSize: '12px',
  },
  sectionTitle: {
    fontWeight: '500',
    flex: 1,
    fontSize: '10px',
  },
  sectionExtra: {
    fontSize: '9px',
    color: 'rgba(255,255,255,0.5)',
    marginRight: '6px',
  },
  expandIcon: {
    fontSize: '12px',
    color: 'rgba(255,255,255,0.3)',
    width: '16px',
    textAlign: 'center',
  },
  progressContainer: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  progressTrack: {
    flex: 1,
    height: '8px',
    background: 'rgba(255,255,255,0.08)',
    borderRadius: '4px',
    overflow: 'hidden',
  },
  progressValue: {
    fontSize: '9px',
    fontWeight: '600',
    minWidth: '28px',
    textAlign: 'right',
    color: 'rgba(255,255,255,0.7)',
  },
  details: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '10px',
    marginTop: '6px',
    paddingLeft: '18px',
    fontSize: '9px',
    color: 'rgba(255,255,255,0.4)',
  },
  networkInfo: {
    display: 'flex',
    alignItems: 'center',
    marginTop: '4px',
    paddingLeft: '18px',
  },
  networkLabel: {
    fontSize: '9px',
    color: 'rgba(255,255,255,0.4)',
    width: '55px',
  },
  networkValue: {
    fontSize: '9px',
    color: 'rgba(255,255,255,0.7)',
    fontFamily: 'SF Mono, Menlo, monospace',
  },
  infoRow: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: '4px',
  },
  infoIcon: {
    fontSize: '10px',
    marginRight: '6px',
  },
  btDevice: {
    fontSize: '9px',
    color: 'rgba(255,255,255,0.6)',
  },
  tempItem: {
    fontSize: '9px',
    color: 'rgba(255,255,255,0.5)',
    marginRight: '10px',
  },
};

// Widget position - uses POSITION config
const positionStyles = {
  'bottom-left': 'bottom: 20px; left: 20px;',
  'bottom-right': 'bottom: 20px; right: 20px;',
  'top-left': 'top: 20px; left: 20px;',
  'top-right': 'top: 20px; right: 20px;',
};

export const className = `
  position: absolute;
  ${positionStyles[POSITION] || positionStyles['bottom-left']}
  z-index: 1;
`;
