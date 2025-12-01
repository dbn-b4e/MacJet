#!/bin/bash
#
# =============================================================================
# MacJet - Desktop Widget Installer
# =============================================================================
#
# Description:
#   Automated installer for the MacJet glassmorphism system monitor widget.
#   This script handles all dependencies and configuration needed to display
#   real-time power, battery, CPU, memory, disk, network, and Bluetooth
#   information on your macOS desktop.
#
# What this script does:
#   1. Checks for and installs Xcode Command Line Tools if not present
#   2. Downloads and installs Übersicht (desktop widget framework) if not present
#   3. Copies the widget files to the Übersicht widgets directory
#   4. Configures Übersicht to start automatically on login
#   5. Launches Übersicht to display the widget immediately
#
# Usage:
#   ./install-widget.sh
#
# Requirements:
#   - macOS 10.15 (Catalina) or later
#   - Internet connection (for Übersicht installation)
#
# Repository: https://github.com/dbn-b4e/MacJet
#
# Author:  B4E SRL - David Baldwin
# License: MIT
# Version: 2.3.4
# Date:    2025-11-29
#
# =============================================================================

set -e  # Exit immediately if a command exits with a non-zero status

# -----------------------------------------------------------------------------
# Configuration
# -----------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WIDGET_SRC="$SCRIPT_DIR/ubersicht-widget"
WIDGET_DST="$HOME/Library/Application Support/Übersicht/widgets/macjet"
WIDGET_OLD="$HOME/Library/Application Support/Übersicht/widgets/power-monitor"
UBERSICHT_APP="/Applications/Übersicht.app"

# -----------------------------------------------------------------------------
# Helper Functions
# -----------------------------------------------------------------------------

# Print a formatted step message
print_step() {
    local step_num=$1
    local total_steps=$2
    local message=$3
    echo "[$step_num/$total_steps] $message"
}

# Print a success indicator
print_success() {
    echo "       $1 ✓"
}

# Check if a command exists
command_exists() {
    command -v "$1" &> /dev/null
}

# -----------------------------------------------------------------------------
# Main Installation Process
# -----------------------------------------------------------------------------

echo "========================================"
echo " MacJet - Desktop Widget Installer"
echo " B4E SRL - David Baldwin"
echo "========================================"
echo

TOTAL_STEPS=5

# Step 1: Check/Install Xcode Command Line Tools
# Required for Swift (used for accurate disk purgeable space calculation)
print_step 1 $TOTAL_STEPS "Checking Xcode Command Line Tools..."
if ! xcode-select -p &>/dev/null; then
    echo "       Installing Xcode Command Line Tools..."
    echo "       A dialog may appear - please click 'Install' and wait for completion."
    xcode-select --install
    # Wait for installation to complete
    until xcode-select -p &>/dev/null; do
        sleep 5
    done
    print_success "Xcode Command Line Tools installed"
else
    print_success "Xcode Command Line Tools already installed"
fi

# Step 2: Check/Install Übersicht
# Übersicht is a desktop widget framework that renders HTML/CSS/JS widgets on the desktop
# Downloaded directly from official website (no Homebrew needed)
if [ ! -d "$UBERSICHT_APP" ]; then
    print_step 2 $TOTAL_STEPS "Installing Übersicht..."

    # Download latest release
    UBERSICHT_URL="https://tracesof.net/uebersicht/releases/Uebersicht-1.6.81.app.zip"
    TEMP_DIR=$(mktemp -d)

    echo "       Downloading Übersicht..."
    curl -L -o "$TEMP_DIR/Uebersicht.zip" "$UBERSICHT_URL" 2>/dev/null

    echo "       Extracting..."
    unzip -q "$TEMP_DIR/Uebersicht.zip" -d "$TEMP_DIR"

    echo "       Installing to /Applications..."
    mv "$TEMP_DIR/Übersicht.app" "/Applications/"

    # Cleanup
    rm -rf "$TEMP_DIR"

    print_success "Übersicht installed"
else
    print_step 2 $TOTAL_STEPS "Übersicht already installed ✓"
fi

# Step 3: Copy Widget Files
# The widget consists of a JSX file with embedded Python for data collection
print_step 3 $TOTAL_STEPS "Installing widget..."
mkdir -p "$HOME/Library/Application Support/Übersicht/widgets"

# Remove old power-monitor folder if it exists (legacy name)
if [ -d "$WIDGET_OLD" ]; then
    rm -rf "$WIDGET_OLD"
    print_success "Removed old power-monitor widget"
fi

# Update or install widget
if [ -d "$WIDGET_DST" ]; then
    rm -rf "$WIDGET_DST"
    print_success "Updating existing installation"
fi
cp -r "$WIDGET_SRC" "$WIDGET_DST"
print_success "Installed to: $WIDGET_DST"

# Step 4: Configure Auto-Start
# Add Übersicht to login items so the widget appears automatically after reboot
print_step 4 $TOTAL_STEPS "Configuring start on boot..."
if osascript -e 'tell application "System Events" to get the name of every login item' 2>/dev/null | grep -q "Übersicht"; then
    print_success "Already in login items"
else
    osascript -e 'tell application "System Events" to make login item at end with properties {path:"/Applications/Übersicht.app", hidden:false}' 2>/dev/null || true
    print_success "Added to login items"
fi

# Step 5: Configure sudo for advanced features (optional)
# powermetrics: CPU temperature and fan speed
# purge: Clear purgeable disk space
print_step 5 $TOTAL_STEPS "Configuring advanced features..."

# Check if already configured
SUDOERS_FILE="/etc/sudoers.d/macjet"
if [ -f "$SUDOERS_FILE" ]; then
    print_success "Already configured"
else
    echo
    echo "       Optional: Enable CPU temperature, fan speed, and disk purge?"
    echo "       This requires adding passwordless sudo for 'powermetrics' and 'purge'."
    echo "       You will be prompted for your password once."
    echo
    read -p "       Enable advanced features? [y/N] " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        # Create sudoers entry
        SUDOERS_CONTENT="# MacJet widget - allow powermetrics and purge without password
$USER ALL=(ALL) NOPASSWD: /usr/bin/powermetrics
$USER ALL=(ALL) NOPASSWD: /usr/sbin/purge
$USER ALL=(ALL) NOPASSWD: /usr/bin/tmutil thinlocalsnapshots"

        echo "$SUDOERS_CONTENT" | sudo tee "$SUDOERS_FILE" > /dev/null
        sudo chmod 440 "$SUDOERS_FILE"
        print_success "Advanced features enabled"
    else
        print_success "Skipped (CPU temp/fan/purge won't be available)"
    fi
fi

# Launch Übersicht
echo
echo "Launching Übersicht..."
open -a Übersicht

# -----------------------------------------------------------------------------
# Installation Complete
# -----------------------------------------------------------------------------

echo
echo "========================================"
echo " Installation complete!"
echo "========================================"
echo
echo "The widget should now appear on your desktop (bottom-left corner)."
echo
echo "Customization options:"
echo "  Scale:        Edit macjet.jsx → SCALE (1.0 = 100%, 1.2 = 120%)"
echo "  Position:     Edit macjet.jsx → POSITION ('bottom-left', 'top-right', etc.)"
echo "  Refresh rate: Edit macjet.jsx → refreshFrequency (default: 5000ms)"
echo
echo "Widget location:"
echo "  $WIDGET_DST"
echo
echo "To uninstall:"
echo "  rm -rf \"$WIDGET_DST\""
echo "  rm -rf /Applications/Übersicht.app  # Optional"
echo
