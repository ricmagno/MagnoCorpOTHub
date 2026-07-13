/**
 * Unit Tests for CategorySection Component
 * Tests category display, expand/collapse functionality
 *
 * Requirements: 2.1, 2.2, 2.3
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { CategorySection } from '../CategorySection';
import { Configuration, ConfigurationCategory, RevealedValues } from '../../../types/configuration';

describe('CategorySection Component', () => {
  const mockConfigurations: Configuration[] = [
    {
      name: 'Database Host',
      value: 'localhost',
      description: 'Database host',
      category: ConfigurationCategory.Database,
      dataType: 'string',
      isSensitive: false,
      isDefault: false,
      requiresRestart: true,
      environmentVariable: 'DB_HOST'
    },
    {
      name: 'Database Port',
      value: '1433',
      description: 'Database port',
      category: ConfigurationCategory.Database,
      dataType: 'number',
      isSensitive: false,
      isDefault: false,
      requiresRestart: true,
      environmentVariable: 'DB_PORT'
    },
    {
      name: 'Database Password',
      value: '••••••••',
      description: 'Database password',
      category: ConfigurationCategory.Database,
      dataType: 'string',
      isSensitive: true,
      isDefault: false,
      requiresRestart: false,
      environmentVariable: 'DB_PASSWORD'
    }
  ];

  const mockOnToggleExpand = jest.fn();
  const mockOnRevealValue = jest.fn();
  const mockOnEditConfiguration = jest.fn();
  const emptyRevealedValues: RevealedValues = {};

  beforeEach(() => {
    jest.clearAllMocks();
  });

  const renderSection = (overrides: Partial<React.ComponentProps<typeof CategorySection>> = {}) => {
    const props: React.ComponentProps<typeof CategorySection> = {
      category: ConfigurationCategory.Database,
      configurations: mockConfigurations,
      isExpanded: true,
      onToggleExpand: mockOnToggleExpand,
      revealedValues: emptyRevealedValues,
      onRevealValue: mockOnRevealValue,
      isEditable: true,
      onEditConfiguration: mockOnEditConfiguration,
      ...overrides
    };
    return render(<CategorySection {...props} />);
  };

  describe('Category Display', () => {
    it('should display category name', () => {
      renderSection();

      expect(screen.getByText('Database')).toBeInTheDocument();
    });

    it('should display configuration count', () => {
      renderSection();

      expect(screen.getByText('3')).toBeInTheDocument();
    });

    it('should display correct count for different category sizes', () => {
      renderSection({ configurations: [mockConfigurations[0]] });

      expect(screen.getByText('1')).toBeInTheDocument();
    });
  });

  describe('Expand/Collapse Button', () => {
    it('should display expand/collapse button', () => {
      renderSection();

      const button = screen.getByRole('button', { name: /toggle database/i });
      expect(button).toBeInTheDocument();
    });

    it('should call onToggleExpand when button is clicked', () => {
      renderSection();

      const button = screen.getByRole('button', { name: /toggle database/i });
      fireEvent.click(button);

      expect(mockOnToggleExpand).toHaveBeenCalledWith(ConfigurationCategory.Database);
    });

    it('should mark the header as expanded when isExpanded is true', () => {
      renderSection({ isExpanded: true });

      const button = screen.getByRole('button', { name: /toggle database/i });
      expect(button).toHaveAttribute('aria-expanded', 'true');
    });

    it('should mark the header as collapsed when isExpanded is false', () => {
      renderSection({ isExpanded: false });

      const button = screen.getByRole('button', { name: /toggle database/i });
      expect(button).toHaveAttribute('aria-expanded', 'false');
    });
  });

  describe('Configuration Display', () => {
    it('should display all configurations when expanded', () => {
      renderSection({ isExpanded: true });

      expect(screen.getByText('Database Host')).toBeInTheDocument();
      expect(screen.getByText('Database Port')).toBeInTheDocument();
      expect(screen.getByText('Database Password')).toBeInTheDocument();
    });

    it('should not display configurations when collapsed', () => {
      renderSection({ isExpanded: false });

      expect(screen.queryByText('Database Host')).not.toBeInTheDocument();
      expect(screen.queryByText('Database Port')).not.toBeInTheDocument();
      expect(screen.queryByText('Database Password')).not.toBeInTheDocument();
    });

    it('should pass the reveal state for each configuration to its card', () => {
      renderSection({
        isExpanded: true,
        revealedValues: { DB_PASSWORD: true }
      });

      expect(screen.getByRole('button', { name: /hide sensitive value/i })).toBeInTheDocument();
    });

    it('should call onRevealValue with the environment variable when a reveal button is clicked', async () => {
      renderSection({ isExpanded: true });

      fireEvent.click(screen.getByRole('button', { name: /show sensitive value/i }));

      await waitFor(() => {
        expect(mockOnRevealValue).toHaveBeenCalledWith('DB_PASSWORD');
      });
    });
  });

  describe('Empty Category', () => {
    it('should handle empty configuration list', () => {
      renderSection({ configurations: [] });

      expect(screen.getByText('Database')).toBeInTheDocument();
      expect(screen.getByText('0')).toBeInTheDocument();
    });
  });

  describe('Different Categories', () => {
    it('should display Application category', () => {
      const appConfigs: Configuration[] = [
        {
          name: 'NODE_ENV',
          value: 'production',
          description: 'Node environment',
          category: ConfigurationCategory.Application,
          dataType: 'string',
          isSensitive: false,
          isDefault: false,
          requiresRestart: true,
          environmentVariable: 'NODE_ENV'
        }
      ];

      renderSection({ category: ConfigurationCategory.Application, configurations: appConfigs });

      expect(screen.getByText('Application')).toBeInTheDocument();
    });

    it('should display Security category', () => {
      const securityConfigs: Configuration[] = [
        {
          name: 'JWT_SECRET',
          value: '••••••••',
          description: 'JWT secret',
          category: ConfigurationCategory.Security,
          dataType: 'string',
          isSensitive: true,
          isDefault: false,
          requiresRestart: false,
          environmentVariable: 'JWT_SECRET'
        }
      ];

      renderSection({ category: ConfigurationCategory.Security, configurations: securityConfigs });

      expect(screen.getByText('Security')).toBeInTheDocument();
    });

    it('should display Email category', () => {
      const emailConfigs: Configuration[] = [
        {
          name: 'SMTP_HOST',
          value: 'smtp.example.com',
          description: 'SMTP host',
          category: ConfigurationCategory.Email,
          dataType: 'string',
          isSensitive: false,
          isDefault: false,
          requiresRestart: false,
          environmentVariable: 'SMTP_HOST'
        }
      ];

      renderSection({ category: ConfigurationCategory.Email, configurations: emailConfigs });

      expect(screen.getByText('Email')).toBeInTheDocument();
    });
  });

  describe('Editable State', () => {
    it('should show edit buttons on configurations when isEditable is true', () => {
      renderSection({ isEditable: true });

      expect(screen.getAllByRole('button', { name: /^edit/i }).length).toBeGreaterThan(0);
    });

    it('should not show edit buttons on configurations when isEditable is false', () => {
      renderSection({ isEditable: false });

      expect(screen.queryAllByRole('button', { name: /^edit/i }).length).toBe(0);
    });
  });

  describe('Accessibility', () => {
    it('should have proper ARIA labels', () => {
      renderSection();

      const button = screen.getByRole('button', { name: /toggle database/i });
      expect(button.getAttribute('aria-expanded')).toBeDefined();
    });

    it('should have proper heading hierarchy', () => {
      renderSection();

      const categoryHeading = screen.getByRole('heading', { level: 2 });
      expect(categoryHeading).toHaveTextContent('Database');
    });

    it('should have a descriptive toggle button label', () => {
      renderSection();

      const button = screen.getByRole('button', { name: /toggle database/i });
      expect(button.getAttribute('aria-label')).toContain('Database');
    });
  });
});
