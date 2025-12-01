#!/usr/bin/env python3
"""
=============================================================================
MacBook Power Monitor - Terminal Dashboard
=============================================================================

Description:
    A real-time terminal dashboard for monitoring MacBook power, battery,
    CPU, memory, and disk information. Uses curses for a flicker-free
    live-updating display.

Features:
    - Power source information (adapter wattage, voltage, current)
    - System power draw in watts
    - CPU usage percentage with visual progress bar
    - CPU thermal throttling indicator
    - Memory usage breakdown (app, wired, compressed, cached)
    - Disk space with APFS purgeable space reporting
    - Battery status (charge, health, cycles, cell voltages)
    - Charging/discharging time estimates
    - Power balance calculation with headroom indicator

Data Sources:
    - ioreg -rn AppleSmartBattery  : Battery and adapter hardware data
    - pmset -g batt                 : Battery percentage and status
    - pmset -g therm                : Thermal throttling information
    - top -l 1                      : CPU usage statistics
    - vm_stat                       : Memory page statistics
    - diskutil info /               : APFS disk space information

Usage:
    python3 power_monitor.py

Controls:
    q, Q    : Quit the application
    r, R    : Force immediate data refresh
    Ctrl+C  : Exit

Requirements:
    - macOS (tested on Sonoma/Sequoia)
    - Python 3.6+
    - No external dependencies (uses only standard library)

Repository: https://github.com/dbn-b4e/MacJet

Author:  B4E SRL - David Baldwin
License: MIT
Version: 2.3.1
Date:    2025-11-29

=============================================================================
"""

import subprocess
import re
import time
import sys
import curses
from datetime import datetime


# =============================================================================
# Shell Command Execution
# =============================================================================

def run_cmd(cmd):
    """
    Execute a shell command and return its stdout.

    Args:
        cmd (str): Shell command to execute

    Returns:
        str: Command stdout, or empty string on error/timeout

    Note:
        Commands are executed with a 5-second timeout to prevent hangs.
    """
    try:
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=5)
        return result.stdout
    except subprocess.TimeoutExpired:
        return ""
    except Exception:
        return ""


# =============================================================================
# Data Collection Functions
# =============================================================================

def parse_ioreg_battery():
    """
    Parse battery and adapter information from the I/O Registry.

    Queries AppleSmartBattery via ioreg to get detailed hardware-level
    information about the battery state and connected power adapter.

    Returns:
        dict: Battery information containing:
            - current_capacity_mah (int): Current charge in mAh
            - max_capacity_mah (int): Maximum capacity in mAh
            - design_capacity_mah (int): Original design capacity in mAh
            - voltage_mv (int): Current battery voltage in millivolts
            - amperage_ma (int): Instantaneous current draw in milliamps (negative = discharging)
            - is_charging (bool): True if battery is currently charging
            - external_connected (bool): True if power adapter is connected
            - cycle_count (int): Number of charge cycles
            - adapter_watts (int): Adapter power rating in watts
            - adapter_voltage_mv (int): Adapter output voltage in millivolts
            - adapter_current_ma (int): Adapter current capacity in milliamps
            - system_power_mw (int): Current system power draw in milliwatts
            - charging_current_ma (int): Current charging rate in milliamps
            - charging_voltage_mv (int): Charging voltage in millivolts
            - cell_voltages (list[int]): Individual cell voltages in millivolts
    """
    output = run_cmd("ioreg -rn AppleSmartBattery")

    info = {}

    # Current capacity - how much charge the battery currently holds
    match = re.search(r'"CurrentCapacity"\s*=\s*(\d+)', output)
    info['current_capacity_mah'] = int(match.group(1)) if match else 0

    # Max capacity - the current maximum the battery can hold (degrades over time)
    match = re.search(r'"MaxCapacity"\s*=\s*(\d+)', output)
    info['max_capacity_mah'] = int(match.group(1)) if match else 0

    # Design capacity - the original factory capacity
    match = re.search(r'"DesignCapacity"=(\d+)', output)
    info['design_capacity_mah'] = int(match.group(1)) if match else 0

    # Battery voltage - current voltage across the battery
    match = re.search(r'"Voltage"\s*=\s*(\d+)', output)
    info['voltage_mv'] = int(match.group(1)) if match else 0

    # Instantaneous amperage - positive when charging, negative when discharging
    match = re.search(r'"InstantAmperage"\s*=\s*(-?\d+)', output)
    info['amperage_ma'] = int(match.group(1)) if match else 0

    # Charging state
    match = re.search(r'"IsCharging"\s*=\s*(Yes|No)', output)
    info['is_charging'] = match.group(1) == 'Yes' if match else False

    # External power connected
    match = re.search(r'"ExternalConnected"\s*=\s*(Yes|No)', output)
    info['external_connected'] = match.group(1) == 'Yes' if match else False

    # Cycle count - number of complete charge/discharge cycles
    match = re.search(r'"CycleCount"=(\d+)', output)
    info['cycle_count'] = int(match.group(1)) if match else 0

    # Adapter wattage rating
    match = re.search(r'"Watts"=(\d+)', output)
    info['adapter_watts'] = int(match.group(1)) if match else 0

    # Adapter output voltage
    match = re.search(r'"AdapterVoltage"=(\d+)', output)
    info['adapter_voltage_mv'] = int(match.group(1)) if match else 0

    # Adapter maximum current
    match = re.search(r'"Current"=(\d+)', output)
    info['adapter_current_ma'] = int(match.group(1)) if match else 0

    # System power consumption (what the Mac is drawing)
    match = re.search(r'"SystemPowerIn"=(\d+)', output)
    info['system_power_mw'] = int(match.group(1)) if match else 0

    # Current charging rate
    match = re.search(r'"ChargingCurrent"=(\d+)', output)
    info['charging_current_ma'] = int(match.group(1)) if match else 0

    # Voltage used for charging
    match = re.search(r'"ChargingVoltage"=(\d+)', output)
    info['charging_voltage_mv'] = int(match.group(1)) if match else 0

    # Individual cell voltages (3-cell battery pack)
    match = re.search(r'"CellVoltage"=\((\d+),(\d+),(\d+)\)', output)
    if match:
        info['cell_voltages'] = [int(match.group(i)) for i in range(1, 4)]
    else:
        info['cell_voltages'] = [0, 0, 0]

    return info


def parse_pmset():
    """
    Parse battery status from pmset power management tool.

    pmset provides the user-friendly battery percentage and status
    that matches what the menu bar shows.

    Returns:
        dict: Power management info containing:
            - percentage (int): Battery charge percentage (0-100)
            - status (str): Battery status ('Charging', 'Discharging', 'Fully Charged', 'On AC', 'Unknown')
            - time_remaining (str): Estimated time remaining (if available)
    """
    output = run_cmd("pmset -g batt")

    info = {}

    # Battery percentage
    match = re.search(r'(\d+)%', output)
    info['percentage'] = int(match.group(1)) if match else 0

    # Determine status from output text
    if 'charging' in output.lower() and 'discharging' not in output.lower():
        info['status'] = 'Charging'
    elif 'discharging' in output.lower():
        info['status'] = 'Discharging'
    elif 'charged' in output.lower():
        info['status'] = 'Fully Charged'
    elif 'AC Power' in output:
        info['status'] = 'On AC'
    else:
        info['status'] = 'Unknown'

    # Time remaining estimate (if provided by system)
    match = re.search(r'(\d+:\d+)\s*remaining', output)
    info['time_remaining'] = match.group(1) if match else 'N/A'

    return info


def parse_thermal():
    """
    Get thermal throttling information from pmset.

    When the Mac gets too hot, macOS reduces CPU speed to manage thermals.
    This function returns the current CPU speed limit percentage.

    Returns:
        dict: Thermal info containing:
            - cpu_speed_limit (int): CPU speed as percentage of max (100 = no throttling)
    """
    output = run_cmd("pmset -g therm")
    info = {}
    match = re.search(r'CPU_Speed_Limit\s*=\s*(\d+)', output)
    info['cpu_speed_limit'] = int(match.group(1)) if match else 100
    return info


def get_cpu_usage():
    """
    Get current CPU usage percentage.

    Uses the 'top' command to get a snapshot of CPU utilization.
    Returns the sum of user and system CPU time.

    Returns:
        float: CPU usage percentage (0-100+, can exceed 100 on multi-core)
    """
    output = run_cmd("top -l 1 -n 0 | grep 'CPU usage'")
    match = re.search(r'(\d+\.?\d*)%\s*user.*?(\d+\.?\d*)%\s*sys', output)
    if match:
        return float(match.group(1)) + float(match.group(2))
    return 0


def get_memory_info():
    """
    Get detailed memory usage information.

    Parses vm_stat output to calculate memory usage breakdown similar
    to Activity Monitor. Memory categories:

    - App Memory: Active + Wired (memory actively used by apps)
    - Wired: Memory that cannot be paged out (kernel, drivers)
    - Compressed: Memory compressed to save space
    - Cached: Inactive + Purgeable + Speculative (can be reclaimed)
    - Free: Completely unused memory

    Returns:
        dict: Memory statistics containing:
            - total_gb (float): Total physical RAM in GB
            - app_gb (float): App memory (active + wired) in GB
            - wired_gb (float): Wired memory in GB
            - compressed_gb (float): Compressed memory in GB
            - cached_gb (float): Cached memory in GB
            - free_gb (float): Free memory in GB
            - purgeable_gb (float): Purgeable memory in GB
            - used_pct (float): Usage percentage (app + compressed)
    """
    # Get total physical memory
    output = run_cmd("sysctl -n hw.memsize")
    total_bytes = int(output.strip()) if output.strip().isdigit() else 16 * 1024**3
    total_gb = total_bytes / (1024**3)

    # Parse vm_stat output for page counts
    output = run_cmd("vm_stat")
    pages = {}
    for line in output.split('\n'):
        match = re.match(r'(.+):\s+(\d+)', line)
        if match:
            pages[match.group(1).strip()] = int(match.group(2))

    # Get page size (16KB on Apple Silicon, 4KB on Intel)
    page_size_output = run_cmd("pagesize")
    page_size = int(page_size_output.strip()) if page_size_output.strip().isdigit() else 16384

    # Calculate memory categories in bytes
    free = pages.get('Pages free', 0) * page_size
    active = pages.get('Pages active', 0) * page_size
    inactive = pages.get('Pages inactive', 0) * page_size
    speculative = pages.get('Pages speculative', 0) * page_size
    wired = pages.get('Pages wired down', 0) * page_size
    compressed = pages.get('Pages occupied by compressor', 0) * page_size
    purgeable = pages.get('Pages purgeable', 0) * page_size

    # App memory = what's actively being used
    app_memory = active + wired
    # Cached = memory that can be reclaimed if needed
    cached = inactive + purgeable + speculative

    return {
        'total_gb': total_gb,
        'app_gb': app_memory / (1024**3),
        'wired_gb': wired / (1024**3),
        'compressed_gb': compressed / (1024**3),
        'cached_gb': cached / (1024**3),
        'free_gb': free / (1024**3),
        'purgeable_gb': purgeable / (1024**3),
        'used_pct': (app_memory + compressed) / total_bytes * 100
    }


def get_disk_info():
    """
    Get disk space information for the boot volume.

    Uses diskutil to get accurate APFS container space reporting.
    APFS (Apple File System) uses a shared container model where
    multiple volumes share the same pool of storage.

    Note on APFS space:
    - Container Total Space: Total capacity of the APFS container
    - Container Free Space: Unallocated space in the container
    - Volume Used Space: Space used by the specific volume
    - Purgeable: Space that can be reclaimed (caches, Time Machine local snapshots)

    Returns:
        dict: Disk statistics containing:
            - total_gb (float): Total container capacity in GB
            - used_gb (float): Used space in GB
            - available_gb (float): Available space in GB
            - purgeable_gb (float): Purgeable space in GB
            - used_pct (int): Usage percentage
    """
    info = {'total_gb': 0, 'used_gb': 0, 'available_gb': 0, 'used_pct': 0, 'purgeable_gb': 0}

    # Get container info from diskutil for accurate APFS reporting
    output = run_cmd("diskutil info /")

    # Parse Container Total Space (total APFS container capacity)
    match = re.search(r'Container Total Space:\s*([\d.]+)\s*(GB|TB)', output)
    if match:
        size = float(match.group(1))
        if match.group(2) == 'TB':
            size *= 1024
        info['total_gb'] = size

    # Parse Container Free Space (actual available in container)
    match = re.search(r'Container Free Space:\s*([\d.]+)\s*(GB|TB)', output)
    if match:
        size = float(match.group(1))
        if match.group(2) == 'TB':
            size *= 1024
        info['available_gb'] = size
        info['purgeable_gb'] = size  # On APFS, free space is inherently purgeable

    # Parse volume used space
    match = re.search(r'Volume Used Space:\s*([\d.]+)\s*(GB|TB|MB)', output)
    if match:
        size = float(match.group(1))
        if match.group(2) == 'TB':
            size *= 1024
        elif match.group(2) == 'MB':
            size /= 1024
        info['used_gb'] = size

    # Calculate used from total - free if not directly available
    if info['used_gb'] == 0 and info['total_gb'] > 0:
        info['used_gb'] = info['total_gb'] - info['available_gb']

    # Calculate usage percentage
    if info['total_gb'] > 0:
        info['used_pct'] = int(info['used_gb'] / info['total_gb'] * 100)

    return info


# =============================================================================
# Display Functions
# =============================================================================

def make_bar(pct, width=30, fill='█', empty='░'):
    """
    Create an ASCII progress bar.

    Args:
        pct (float): Percentage to fill (0-100)
        width (int): Total width of the bar in characters
        fill (str): Character to use for filled portion
        empty (str): Character to use for empty portion

    Returns:
        str: Progress bar string of specified width

    Example:
        >>> make_bar(75, 20)
        '███████████████░░░░░'
    """
    pct = max(0, min(100, pct))  # Clamp to 0-100
    filled = int(width * pct / 100)
    return fill * filled + empty * (width - filled)


def draw_dashboard(stdscr):
    """
    Main dashboard rendering loop using curses.

    This function handles:
    - Curses initialization and color setup
    - Periodic data collection (every 10 seconds)
    - Screen rendering with colored output
    - User input handling (q=quit, r=refresh)

    Args:
        stdscr: Curses window object (provided by curses.wrapper)

    The dashboard displays:
    - Power source (adapter info)
    - System power draw and CPU usage
    - Memory usage breakdown
    - Disk space information
    - Battery status and health
    - Charging/discharging estimates
    - Power balance with headroom calculation
    """
    curses.curs_set(0)  # Hide cursor
    stdscr.nodelay(1)   # Non-blocking input

    # Initialize color pairs for terminal output
    curses.start_color()
    curses.use_default_colors()
    curses.init_pair(1, curses.COLOR_GREEN, -1)   # Green - good status
    curses.init_pair(2, curses.COLOR_YELLOW, -1)  # Yellow - warning
    curses.init_pair(3, curses.COLOR_RED, -1)     # Red - critical
    curses.init_pair(4, curses.COLOR_CYAN, -1)    # Cyan - headers
    curses.init_pair(5, curses.COLOR_WHITE, -1)   # White - normal text

    GREEN = curses.color_pair(1)
    YELLOW = curses.color_pair(2)
    RED = curses.color_pair(3)
    CYAN = curses.color_pair(4)
    WHITE = curses.color_pair(5)
    BOLD = curses.A_BOLD

    last_update = 0
    update_interval = 10  # Seconds between data refreshes

    # Initialize data variables
    battery = pmset = thermal = memory = disk = None
    cpu = 0

    while True:
        current_time = time.time()

        # Handle user input
        key = stdscr.getch()
        if key == ord('q') or key == ord('Q'):
            break
        elif key == ord('r') or key == ord('R'):
            last_update = 0  # Force immediate refresh

        # Collect data at specified interval
        if current_time - last_update >= update_interval:
            battery = parse_ioreg_battery()
            pmset = parse_pmset()
            thermal = parse_thermal()
            cpu = get_cpu_usage()
            memory = get_memory_info()
            disk = get_disk_info()
            last_update = current_time

        # Skip rendering if data not yet collected
        if battery is None:
            continue

        # Clear screen and get dimensions
        stdscr.erase()
        height, width = stdscr.getmaxyx()

        row = 0

        # === Header ===
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        header = f" MacBook Power Monitor - {now} "
        stdscr.addstr(row, 0, "=" * min(width-1, 65), CYAN | BOLD)
        row += 1
        stdscr.addstr(row, 0, header.center(65), CYAN | BOLD)
        row += 1
        stdscr.addstr(row, 0, "=" * min(width-1, 65), CYAN | BOLD)
        row += 2

        # === Power Source Section ===
        stdscr.addstr(row, 0, "⚡ POWER SOURCE", YELLOW | BOLD)
        row += 1
        if battery['external_connected']:
            stdscr.addstr(row, 2, f"Adapter:        {battery['adapter_watts']}W", GREEN)
            row += 1
            stdscr.addstr(row, 2, f"Voltage:        {battery['adapter_voltage_mv']/1000:.1f}V @ {battery['adapter_current_ma']/1000:.1f}A max", WHITE)
        else:
            stdscr.addstr(row, 2, "Source:         Battery Only", YELLOW)
        row += 2

        # === System Section ===
        stdscr.addstr(row, 0, "💻 SYSTEM", YELLOW | BOLD)
        row += 1
        system_w = battery['system_power_mw'] / 1000
        stdscr.addstr(row, 2, f"Power Draw:     {system_w:.1f}W", WHITE)
        row += 1

        # CPU usage with color-coded bar
        cpu_color = GREEN if cpu < 50 else YELLOW if cpu < 80 else RED
        stdscr.addstr(row, 2, f"CPU Usage:      ", WHITE)
        stdscr.addstr(row, 18, make_bar(cpu, 20), cpu_color)
        stdscr.addstr(row, 40, f" {cpu:.1f}%", WHITE)
        row += 1

        # CPU throttle status
        throttle_color = WHITE if thermal['cpu_speed_limit'] == 100 else RED
        stdscr.addstr(row, 2, f"CPU Throttle:   {thermal['cpu_speed_limit']}%", throttle_color)
        row += 2

        # === Memory Section ===
        stdscr.addstr(row, 0, "🧠 MEMORY", YELLOW | BOLD)
        row += 1
        mem_color = GREEN if memory['used_pct'] < 70 else YELLOW if memory['used_pct'] < 90 else RED
        stdscr.addstr(row, 2, f"Used:           {memory['app_gb']:.1f}/{memory['total_gb']:.0f} GB ({memory['used_pct']:.0f}%)  ", WHITE)
        stdscr.addstr(row, 42, make_bar(memory['used_pct'], 15), mem_color)
        row += 1
        stdscr.addstr(row, 2, f"Wired: {memory['wired_gb']:.1f}GB  Compressed: {memory['compressed_gb']:.1f}GB  Cached: {memory['cached_gb']:.1f}GB", WHITE)
        row += 2

        # === Disk Section ===
        stdscr.addstr(row, 0, "💾 DISK", YELLOW | BOLD)
        row += 1
        disk_color = GREEN if disk['used_pct'] < 70 else YELLOW if disk['used_pct'] < 90 else RED
        stdscr.addstr(row, 2, f"Used:           {disk['used_gb']:.0f}/{disk['total_gb']:.0f} GB ({disk['used_pct']}%)  ", WHITE)
        stdscr.addstr(row, 42, make_bar(disk['used_pct'], 15), disk_color)
        row += 1
        stdscr.addstr(row, 2, f"Available: {disk['available_gb']:.0f}GB  Purgeable: {disk['purgeable_gb']:.1f}GB", WHITE)
        row += 2

        # === Battery Section ===
        stdscr.addstr(row, 0, "🔋 BATTERY", YELLOW | BOLD)
        row += 1
        batt_pct = pmset['percentage']
        batt_color = GREEN if batt_pct > 50 else YELLOW if batt_pct > 20 else RED
        stdscr.addstr(row, 2, f"Charge:         ", WHITE)
        stdscr.addstr(row, 18, make_bar(batt_pct, 20), batt_color)
        status_color = GREEN if battery['is_charging'] else WHITE
        stdscr.addstr(row, 40, f" {batt_pct}% {pmset['status']}", status_color)
        row += 1
        stdscr.addstr(row, 2, f"Capacity:       {battery['current_capacity_mah']}/{battery['max_capacity_mah']} mAh", WHITE)
        row += 1

        # Battery health calculation
        health = (battery['max_capacity_mah'] / battery['design_capacity_mah'] * 100) if battery['design_capacity_mah'] > 0 else 0
        health_color = GREEN if health > 80 else YELLOW if health > 60 else RED
        stdscr.addstr(row, 2, f"Health:         {health:.1f}%  Cycles: {battery['cycle_count']}", health_color)
        row += 1
        stdscr.addstr(row, 2, f"Voltage:        {battery['voltage_mv']/1000:.2f}V", WHITE)
        row += 1
        cells = battery['cell_voltages']
        stdscr.addstr(row, 2, f"Cells:          {cells[0]}mV | {cells[1]}mV | {cells[2]}mV", WHITE)
        row += 2

        # === Charging/Discharging Section ===
        if battery['is_charging']:
            stdscr.addstr(row, 0, "⚡ CHARGING", GREEN | BOLD)
            row += 1
            charge_power = battery['charging_current_ma'] * battery['voltage_mv'] / 1000000
            stdscr.addstr(row, 2, f"Power:          {charge_power:.1f}W ({battery['charging_current_ma']/1000:.2f}A @ {battery['charging_voltage_mv']/1000:.2f}V)", WHITE)
            row += 1

            # Time to full calculation
            remaining_mah = battery['max_capacity_mah'] - battery['current_capacity_mah']
            if battery['charging_current_ma'] > 0:
                hours_to_full = remaining_mah / battery['charging_current_ma']
                mins = int(hours_to_full * 60)
                h, m = divmod(mins, 60)
                stdscr.addstr(row, 2, f"Time to Full:   {h}h {m:02d}m", GREEN)
        elif not battery['external_connected']:
            stdscr.addstr(row, 0, "🔌 DISCHARGING", YELLOW | BOLD)
            row += 1
            discharge_ma = abs(battery['amperage_ma'])
            discharge_power = discharge_ma * battery['voltage_mv'] / 1000000
            stdscr.addstr(row, 2, f"Power:          {discharge_power:.1f}W ({discharge_ma/1000:.2f}A)", WHITE)
            row += 1

            # Time to empty calculation
            if discharge_ma > 0:
                hours = battery['current_capacity_mah'] / discharge_ma
                mins = int(hours * 60)
                h, m = divmod(mins, 60)
                stdscr.addstr(row, 2, f"Time to Empty:  {h}h {m:02d}m", YELLOW)
        row += 2

        # === Power Balance Section (when on AC power) ===
        if battery['external_connected']:
            stdscr.addstr(row, 0, "📊 POWER BALANCE", YELLOW | BOLD)
            row += 1

            adapter_max = battery['adapter_watts']
            system = system_w
            charge = battery['charging_current_ma'] * battery['voltage_mv'] / 1000000 if battery['is_charging'] else 0
            total = system + charge
            headroom = adapter_max - total
            pct = min(100, total / adapter_max * 100) if adapter_max > 0 else 0

            stdscr.addstr(row, 2, f"System: {system:.0f}W + Charging: {charge:.0f}W = {total:.0f}W / {adapter_max}W", WHITE)
            row += 1
            bar_color = GREEN if pct < 70 else YELLOW if pct < 90 else RED
            stdscr.addstr(row, 2, f"[{make_bar(pct, 40)}] {pct:.0f}%", bar_color)
            row += 1

            # Headroom indicator
            if headroom >= 0:
                headroom_color = GREEN if headroom > 20 else YELLOW
                stdscr.addstr(row, 2, f"Headroom: {headroom:.0f}W", headroom_color)
            else:
                stdscr.addstr(row, 2, f"Battery supplementing: {-headroom:.0f}W (adapter maxed)", RED)
            row += 2

        # === Footer ===
        countdown = int(update_interval - (current_time - last_update))
        stdscr.addstr(row, 0, "=" * min(width-1, 65), CYAN)
        row += 1
        stdscr.addstr(row, 0, f" [Q] Quit  [R] Refresh  Next update: {countdown}s ", WHITE)

        stdscr.refresh()
        time.sleep(0.5)  # Small delay to reduce CPU usage


# =============================================================================
# Main Entry Point
# =============================================================================

def main():
    """
    Application entry point.

    Wraps the curses dashboard in proper initialization/cleanup,
    handling keyboard interrupts gracefully.
    """
    try:
        curses.wrapper(draw_dashboard)
    except KeyboardInterrupt:
        pass
    print("\nPower Monitor closed.")


if __name__ == "__main__":
    main()
