/**
 * About Section Component
 * Displays application version, build information, and update controls
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8
 */

import React, { useState, useEffect } from 'react';
import {
  RefreshCw, Download, AlertCircle, CheckCircle, Clock, Info,
  FileText, LayoutDashboard, Bell, CalendarClock, Database, Boxes, Users, Palette, Server
} from 'lucide-react';
import { VersionInfo, UpdateCheckResult, UpdateRecord } from '@/types/versionManagement';
import { useBranding } from '../../hooks/useBranding';
import './AboutSection.css';

interface FeatureEntry {
  icon: React.ComponentType<{ size?: number }>;
  title: string;
  description: string;
}

const FEATURES: FeatureEntry[] = [
  {
    icon: FileText,
    title: 'Automated PDF Reports',
    description: 'Customizable, chart-rich report templates generated from historical tag data and scheduled for recurring delivery.'
  },
  {
    icon: LayoutDashboard,
    title: 'Live Dashboards',
    description: 'Real-time widgets, gauges, and trend charts backed by live values from the connected data sources.'
  },
  {
    icon: Bell,
    title: 'Alerts & Notifications',
    description: 'Threshold-based alerting on live tag values, with email delivery to configured recipients.'
  },
  {
    icon: CalendarClock,
    title: 'Scheduling',
    description: 'Cron-based automated report generation and delivery, with a full run history.'
  },
  {
    icon: Database,
    title: 'Multi-Source Data Integration',
    description: 'AVEVA (Wonderware) Historian, OPC UA, and TEVE can all be connected independently, each optional.'
  },
  {
    icon: Boxes,
    title: 'TEVE — Tensor Embedding Vector Engine',
    description: 'A modern time-series & vector-search historian: similarity search over screenshots, metric-window shapes, and anomaly signatures, alongside ordinary tag historization.'
  },
  {
    icon: Users,
    title: 'User & Access Management',
    description: 'Role-based access control with local accounts or LDAP/Active Directory domain authentication.'
  },
  {
    icon: Palette,
    title: 'White-Label Branding',
    description: 'Company name, product name, logo, and color scheme are all admin-configurable.'
  },
  {
    icon: Server,
    title: 'Flexible Deployment',
    description: 'Runs as a web app, Docker container, or Kubernetes deployment.'
  },
];

interface AboutSectionProps {
  onUpdateInstalled?: () => void;
  onUpdateFailed?: (error: Error) => void;
}

interface AboutSectionState {
  versionInfo: VersionInfo | null;
  updateStatus: UpdateCheckResult | null;
  updateHistory: UpdateRecord[];
  isCheckingForUpdates: boolean;
  isInstallingUpdate: boolean;
  updateProgress: number;
  error: string | null;
  loading: boolean;
}

/**
 * AboutSection component displays version and update information
 */
export const AboutSection: React.FC<AboutSectionProps> = ({
  onUpdateInstalled,
  onUpdateFailed
}) => {
  const { branding } = useBranding();
  const productName = [branding.companyName, branding.appName].filter(Boolean).join(' ') || 'MagnoCorp OT Hub';
  const [state, setState] = useState<AboutSectionState>({
    versionInfo: null,
    updateStatus: null,
    updateHistory: [],
    isCheckingForUpdates: true,
    isInstallingUpdate: false,
    updateProgress: 0,
    error: null,
    loading: true
  });

  // Load version and update information on mount
  useEffect(() => {
    loadVersionInfo();
    loadUpdateStatus();
    loadUpdateHistory();
  }, []);

  /**
   * Load current version information
   */
  const loadVersionInfo = async () => {
    try {
      const response = await fetch('/api/version');
      if (!response.ok) {
        throw new Error(`Failed to fetch version information: ${response.status} ${response.statusText}`);
      }
      const data = await response.json();
      setState(prev => ({
        ...prev,
        versionInfo: data.data || data, // Handle wrapper object if present
        loading: false
      }));
    } catch (error) {
      console.error('Error loading version info:', error);
      setState(prev => ({
        ...prev,
        error: error instanceof Error ? error.message : 'Failed to load version',
        loading: false
      }));
    }
  };

  /**
   * Load current update status
   */
  const loadUpdateStatus = async () => {
    try {
      const response = await fetch('/api/updates/status');
      if (!response.ok) {
        throw new Error(`Failed to fetch update status: ${response.status} ${response.statusText}`);
      }
      const data = await response.json();
      setState(prev => ({
        ...prev,
        updateStatus: data.data || data, // Handle wrapper object if present
        isCheckingForUpdates: false // Ensure checking spinner stops
      }));
    } catch (error) {
      console.error('Failed to load update status:', error);
      setState(prev => ({
        ...prev,
        isCheckingForUpdates: false // Ensure checking spinner stops even on error
      }));
    }
  };

  /**
   * Load update history
   */
  const loadUpdateHistory = async () => {
    try {
      const response = await fetch('/api/updates/history?limit=5');
      if (!response.ok) {
        throw new Error('Failed to fetch update history');
      }
      const data = await response.json();
      setState(prev => ({
        ...prev,
        updateHistory: data.data.records || []
      }));
    } catch (error) {
      console.error('Failed to load update history:', error);
    }
  };

  /*
   * Check for updates
   */
  const handleCheckForUpdates = async () => {
    setState(prev => ({
      ...prev,
      isCheckingForUpdates: true,
      error: null
    }));

    try {
      const response = await fetch('/api/updates/check?force=true');
      if (!response.ok) {
        throw new Error(`Failed to check for updates: ${response.status} ${response.statusText}`);
      }
      const data = await response.json();
      setState(prev => ({
        ...prev,
        updateStatus: data.data || data,
        isCheckingForUpdates: false
      }));
    } catch (error) {
      console.error('Error checking for updates:', error);
      setState(prev => ({
        ...prev,
        error: error instanceof Error ? error.message : 'Failed to check for updates',
        isCheckingForUpdates: false
      }));
    }
  };

  /**
   * Reload/restart the application
   */
  const handleReloadApp = async () => {
    try {
      setState(prev => ({
        ...prev,
        error: null
      }));

      // Call the restart endpoint
      const response = await fetch('/api/system/restart', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`Failed to restart application: ${response.status} ${response.statusText}`);
      }

      // Show reloading message
      alert('Application is restarting...\n\nThe page will automatically reload in a few seconds.');

      // Wait a bit for the server to start shutting down
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Poll for server to come back online
      let attempts = 0;
      const maxAttempts = 30; // 30 seconds max
      const pollInterval = 1000; // 1 second

      const checkServerStatus = async (): Promise<boolean> => {
        try {
          const healthResponse = await fetch('/api/health', {
            method: 'GET',
            cache: 'no-cache'
          });
          return healthResponse.ok;
        } catch {
          return false;
        }
      };

      // Poll until server is back or timeout
      while (attempts < maxAttempts) {
        const isOnline = await checkServerStatus();
        if (isOnline) {
          // Server is back, reload the page
          window.location.reload();
          return;
        }
        await new Promise(resolve => setTimeout(resolve, pollInterval));
        attempts++;
      }

      // Timeout - reload anyway
      window.location.reload();

    } catch (error) {
      console.error('Error restarting application:', error);
      setState(prev => ({
        ...prev,
        error: error instanceof Error ? error.message : 'Failed to restart application'
      }));

      // Offer manual reload
      if (window.confirm('Automatic restart failed. Would you like to reload the page manually?')) {
        window.location.reload();
      }
    }
  }

  /**
   * Install update
   */
  const handleInstallUpdate = async () => {
    if (!state.updateStatus?.latestVersion) {
      setState(prev => ({
        ...prev,
        error: 'No update available'
      }));
      return;
    }

    setState(prev => ({
      ...prev,
      isInstallingUpdate: true,
      updateProgress: 0,
      error: null
    }));

    try {
      const response = await fetch('/api/updates/install', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          version: state.updateStatus.latestVersion
        })
      });

      if (!response.ok) {
        throw new Error('Failed to install update');
      }

      // Simulate progress
      let progress = 0;
      const progressInterval = setInterval(() => {
        progress += Math.random() * 30;
        if (progress > 90) progress = 90;
        setState(prev => ({
          ...prev,
          updateProgress: progress
        }));
      }, 500);

      // Wait for installation to complete
      await new Promise(resolve => setTimeout(resolve, 5000));
      clearInterval(progressInterval);

      setState(prev => ({
        ...prev,
        updateProgress: 100,
        isInstallingUpdate: false
      }));

      // Reload update history
      await loadUpdateHistory();

      if (onUpdateInstalled) {
        onUpdateInstalled();
      }

      // Show success message with option to reload
      const shouldReload = window.confirm(
        'Update downloaded successfully!\n\n' +
        'The update has been staged and is ready to apply.\n\n' +
        'Click OK to restart the application now, or Cancel to restart manually later.\n\n' +
        'Note: The application will be unavailable for 5-10 seconds during restart.'
      );

      if (shouldReload) {
        await handleReloadApp();
      } else {
        setTimeout(() => {
          setState(prev => ({
            ...prev,
            updateStatus: null
          }));
        }, 10000);
      }
    } catch (error) {
      setState(prev => ({
        ...prev,
        error: error instanceof Error ? error.message : 'Failed to install update',
        isInstallingUpdate: false,
        updateProgress: 0
      }));

      if (onUpdateFailed && error instanceof Error) {
        onUpdateFailed(error);
      }
    }
  };

  const { versionInfo, updateStatus, updateHistory, isCheckingForUpdates, isInstallingUpdate, updateProgress, error, loading } = state;

  if (loading) {
    return (
      <div className="about-section loading">
        <div className="spinner"></div>
        <p>Loading version information...</p>
      </div>
    );
  }

  return (
    <div className="about-section">
      {/* System Overview */}
      <div className="about-card overview-card">
        <h2>About {productName}</h2>
        <p className="overview-description">
          {productName} is a unified OT reporting and analytics platform for industrial automation.
          It connects to industrial data sources — AVEVA (Wonderware) Historian, OPC UA, and TEVE — to
          extract historical and live tag data, then turns it into printable reports, live dashboards,
          and threshold-based alerts.
        </p>
        <div className="feature-grid">
          {FEATURES.map((feature) => (
            <div key={feature.title} className="feature-item">
              <feature.icon size={18} />
              <div>
                <p className="feature-title">{feature.title}</p>
                <p className="feature-description">{feature.description}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Version Information */}
      <div className="about-card version-card">
        <h2>Application Information</h2>
        {versionInfo && (
          <div className="version-info">
            <div className="info-row">
              <span className="label">Version:</span>
              <span className="value">v{versionInfo.version}</span>
            </div>
            <div className="info-row">
              <span className="label">Build Date:</span>
              <span className="value">{(() => {
                try {
                  return new Date(versionInfo.buildDate).toLocaleString();
                } catch (error) {
                  console.error('Error formatting build date:', error);
                  return versionInfo.buildDate; // Fallback to raw date string
                }
              })()}</span>
            </div>
            <div className="info-row">
              <span className="label">Commit Hash:</span>
              <span className="value monospace">{versionInfo.commitHash.substring(0, 8)}</span>
            </div>
            <div className="info-row">
              <span className="label">Branch:</span>
              <span className="value">{versionInfo.branchName}</span>
            </div>
            {versionInfo.buildNumber && (
              <div className="info-row">
                <span className="label">Build Number:</span>
                <span className="value">{versionInfo.buildNumber}</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Update Status */}
      <div className="about-card update-card">
        <h2>Update Status</h2>
        {error && (
          <div className="error-message">
            <AlertCircle size={16} />
            <span>{error}</span>
          </div>
        )}

        {(() => {
          try {
            if (!updateStatus) {
              return (
                <div className="status-indicator checking">
                  <RefreshCw size={20} className="spinning" />
                  <span>Checking for updates...</span>
                </div>
              );
            }

            return (
              <div className="update-status">
                {updateStatus.isUpdateAvailable ? (
                  <div className="update-available">
                    <div className="status-indicator available">
                      <Download size={20} />
                      <span>Update Available</span>
                    </div>
                    <div className="update-details">
                      <p>New version <strong>v{updateStatus.latestVersion || 'unknown'}</strong> is available</p>
                      {updateStatus.changelog && (
                        <div className="changelog">
                          <h4>What's New:</h4>
                          <p>{typeof updateStatus.changelog === 'string' ? updateStatus.changelog.substring(0, 200) + '...' : 'Changelog not available'}</p>
                        </div>
                      )}
                    </div>
                    {versionInfo?.isDocker ? (
                      <div className="docker-update-notice">
                        <Info size={16} />
                        <p>In-app updates are disabled for Docker. Please pull the latest image to update.</p>
                      </div>
                    ) : (
                      <button
                        className="btn btn-primary"
                        onClick={handleInstallUpdate}
                        disabled={isInstallingUpdate}
                      >
                        {isInstallingUpdate ? 'Installing...' : 'Install Update'}
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="status-indicator up-to-date">
                    <CheckCircle size={20} />
                    <span>Up to Date</span>
                  </div>
                )}

                {updateStatus.lastCheckTime && (
                  <div className="last-check">
                    <Clock size={14} />
                    <span>
                      Last checked: {(() => {
                        try {
                          return new Date(updateStatus.lastCheckTime).toLocaleString();
                        } catch (error) {
                          console.error('Error formatting date:', error);
                          return updateStatus.lastCheckTime; // Fallback to raw date string
                        }
                      })()}
                    </span>
                  </div>
                )}
              </div>
            );
          } catch (error) {
            console.error('Error rendering update status:', error);
            return <div className="error-message">Error displaying update status</div>;
          }
        })()}

        {isInstallingUpdate && (
          <div className="progress-container">
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${updateProgress}%` }}></div>
            </div>
            <p className="progress-text">{Math.round(updateProgress)}% Complete</p>
          </div>
        )}

        <button
          className="btn btn-secondary"
          onClick={handleCheckForUpdates}
          disabled={isCheckingForUpdates || isInstallingUpdate}
        >
          <RefreshCw size={16} className={isCheckingForUpdates ? 'spinning' : ''} />
          {isCheckingForUpdates ? 'Checking...' : 'Check for Updates'}
        </button>
      </div>

      {/* Update History */}
      {updateHistory.length > 0 && (
        <div className="about-card history-card">
          <h2>Recent Updates</h2>
          <div className="update-history">
            {updateHistory.map((record) => (
              <div key={record.id} className="history-item">
                <div className="history-header">
                  <span className="version-range">
                    v{record.fromVersion} → v{record.toVersion}
                  </span>
                  <span className={`status-badge ${record.status}`}>
                    {record.status === 'success' && 'Success'}
                    {record.status === 'failed' && 'Failed'}
                    {record.status === 'rolled_back' && 'Rolled Back'}
                  </span>
                </div>
                <div className="history-details">
                  <span className="timestamp">
                    {(() => {
                      try {
                        return new Date(record.timestamp).toLocaleString();
                      } catch (error) {
                        console.error('Error formatting history date:', error);
                        return record.timestamp; // Fallback to raw date string
                      }
                    })()}
                  </span>
                  {record.errorMessage && (
                    <span className="error-detail">{record.errorMessage}</span>
                  )}
                  {record.installDuration && (
                    <span className="duration">
                      Duration: {Math.round(record.installDuration / 1000)}s
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default AboutSection;
