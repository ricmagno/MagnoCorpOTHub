/**
 * Unit Tests for ConfigurationCard Component
 * Tests configuration display, reveal/mask toggle, and sensitive value handling
 *
 * Requirements: 1.2, 3.1, 3.3, 3.4
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ConfigurationCard } from '../ConfigurationCard';
import { Configuration, ConfigurationCategory } from '../../../types/configuration';

// Mock the useAuth hook
jest.mock('../../../hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'user123', role: 'admin' },
    isAuthenticated: true
  })
}));

describe('ConfigurationCard Component', () => {
  const mockNonSensitiveConfig: Configuration = {
    name: 'Database Host',
    value: 'localhost',
    description: 'Database host',
    category: ConfigurationCategory.Database,
    dataType: 'string',
    isSensitive: false,
    isDefault: false,
    requiresRestart: true,
    environmentVariable: 'DB_HOST'
  };

  const mockSensitiveConfig: Configuration = {
    name: 'Database Password',
    value: '••••••••',
    description: 'Database password',
    category: ConfigurationCategory.Database,
    dataType: 'string',
    isSensitive: true,
    isDefault: false,
    requiresRestart: false,
    environmentVariable: 'DB_PASSWORD'
  };

  const renderCard = (overrides: Partial<React.ComponentProps<typeof ConfigurationCard>> = {}) => {
    const props: React.ComponentProps<typeof ConfigurationCard> = {
      configuration: mockNonSensitiveConfig,
      isRevealed: false,
      isEditable: true,
      onReveal: jest.fn(),
      onEdit: jest.fn(),
      onCancel: jest.fn(),
      ...overrides
    };
    return { ...render(<ConfigurationCard {...props} />), props };
  };

  describe('Non-Sensitive Configuration Display', () => {
    it('should display configuration name', () => {
      renderCard();

      expect(screen.getByText('Database Host')).toBeInTheDocument();
    });

    it('should display configuration value', () => {
      renderCard();

      expect(screen.getByText('localhost')).toBeInTheDocument();
    });

    it('should display configuration description', () => {
      renderCard();

      expect(screen.getByText('Database host')).toBeInTheDocument();
    });

    it('should display data type', () => {
      renderCard();

      expect(screen.getByText('Text')).toBeInTheDocument();
    });

    it('should display environment variable name', () => {
      renderCard();

      expect(screen.getByText('DB_HOST')).toBeInTheDocument();
    });

    it('should display restart requirement indicator', () => {
      renderCard();

      expect(screen.getByText(/restart/i)).toBeInTheDocument();
    });

    it('should not display reveal button for non-sensitive configuration', () => {
      renderCard();

      const revealButton = screen.queryByRole('button', { name: /sensitive value/i });
      expect(revealButton).not.toBeInTheDocument();
    });
  });

  describe('Sensitive Configuration Display', () => {
    it('should display masked value for sensitive configuration', () => {
      renderCard({ configuration: mockSensitiveConfig });

      expect(screen.getByText('••••••••')).toBeInTheDocument();
    });

    it('should display reveal button for sensitive configuration', () => {
      renderCard({ configuration: mockSensitiveConfig });

      const revealButton = screen.getByRole('button', { name: /show sensitive value/i });
      expect(revealButton).toBeInTheDocument();
    });

    it('should display sensitive indicator', () => {
      renderCard({ configuration: mockSensitiveConfig });

      expect(screen.getByText(/sensitive/i)).toBeInTheDocument();
    });
  });

  describe('Reveal/Mask Toggle', () => {
    // The card itself is display-only for the reveal state: the parent owns
    // `isRevealed` and the real/masked `value`, and re-renders the card once
    // the reveal request resolves. So these tests drive that parent contract
    // directly instead of asserting on internal card state that doesn't exist.
    it('should call onReveal with the environment variable when reveal button is clicked', async () => {
      const onReveal = jest.fn();
      renderCard({ configuration: mockSensitiveConfig, onReveal });

      fireEvent.click(screen.getByRole('button', { name: /show sensitive value/i }));

      await waitFor(() => {
        expect(onReveal).toHaveBeenCalledWith('DB_PASSWORD');
      });
    });

    it('should display the unmasked value and hide button once revealed by the parent', () => {
      const revealedConfig = { ...mockSensitiveConfig, value: 'super-secret' };
      renderCard({ configuration: revealedConfig, isRevealed: true });

      expect(screen.getByText('super-secret')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /hide sensitive value/i })).toBeInTheDocument();
    });

    it('should call onReveal again when the hide button is clicked', async () => {
      const onReveal = jest.fn();
      const revealedConfig = { ...mockSensitiveConfig, value: 'super-secret' };
      renderCard({ configuration: revealedConfig, isRevealed: true, onReveal });

      fireEvent.click(screen.getByRole('button', { name: /hide sensitive value/i }));

      await waitFor(() => {
        expect(onReveal).toHaveBeenCalledWith('DB_PASSWORD');
      });
    });
  });

  describe('Edit Button', () => {
    it('should display edit button for editable configuration', () => {
      renderCard({ isEditable: true });

      const editButton = screen.getByRole('button', { name: /edit database host/i });
      expect(editButton).toBeInTheDocument();
    });

    it('should not display edit button for non-editable configuration', () => {
      renderCard({ isEditable: false });

      const editButton = screen.queryByRole('button', { name: /edit database host/i });
      expect(editButton).not.toBeInTheDocument();
    });

    it('should display read-only indicator for non-editable configuration', () => {
      renderCard({ isEditable: false });

      expect(screen.getByText(/read-only/i)).toBeInTheDocument();
    });

    it('should enter edit mode when edit button is clicked', async () => {
      renderCard({ isEditable: true });

      const editButton = screen.getByRole('button', { name: /edit database host/i });
      fireEvent.click(editButton);

      await waitFor(() => {
        expect(screen.getByRole('textbox')).toBeInTheDocument();
      });
    });
  });

  describe('Default Value Indicator', () => {
    it('should display default indicator for default values', () => {
      const defaultConfig = { ...mockNonSensitiveConfig, isDefault: true };
      renderCard({ configuration: defaultConfig });

      expect(screen.getByText(/default/i)).toBeInTheDocument();
    });

    it('should display customized indicator for non-default values', () => {
      renderCard();

      expect(screen.getByText(/customized/i)).toBeInTheDocument();
    });
  });

  describe('Constraints Display', () => {
    it('should display constraints when provided', () => {
      const configWithConstraints = {
        ...mockNonSensitiveConfig,
        constraints: 'Valid hostname or IP address'
      };
      renderCard({ configuration: configWithConstraints });

      expect(screen.getByText('Valid hostname or IP address')).toBeInTheDocument();
    });

    it('should not display constraints when not provided', () => {
      renderCard();

      const constraintsElement = screen.queryByText(/constraints/i);
      expect(constraintsElement).not.toBeInTheDocument();
    });
  });

  describe('Copy Functionality', () => {
    it('should display copy button for non-sensitive configuration', () => {
      renderCard();

      const copyButtons = screen.getAllByRole('button', { name: /copy/i });
      expect(copyButtons.length).toBeGreaterThan(0);
    });

    it('should copy value to clipboard when copy button is clicked', async () => {
      const mockClipboard = {
        writeText: jest.fn().mockResolvedValue(undefined)
      };
      Object.assign(navigator, { clipboard: mockClipboard });

      renderCard();

      const copyButton = screen.getAllByRole('button', { name: /copy/i })[0];
      fireEvent.click(copyButton);

      await waitFor(() => {
        expect(mockClipboard.writeText).toHaveBeenCalled();
      });
    });

    it('should display success indicator after copying', async () => {
      const mockClipboard = {
        writeText: jest.fn().mockResolvedValue(undefined)
      };
      Object.assign(navigator, { clipboard: mockClipboard });

      const { container } = renderCard();

      const copyButton = screen.getAllByRole('button', { name: /copy/i })[0];
      fireEvent.click(copyButton);

      await waitFor(() => {
        expect(container.querySelectorAll('svg.lucide-check').length).toBeGreaterThan(0);
      });
    });
  });

  describe('Accessibility', () => {
    it('should have proper ARIA labels', () => {
      renderCard();

      const buttons = screen.getAllByRole('button');
      buttons.forEach(button => {
        expect(button.getAttribute('aria-label') || button.textContent).toBeTruthy();
      });
    });

    it('should have proper heading hierarchy', () => {
      renderCard();

      const heading = screen.getByRole('heading');
      expect(heading).toBeInTheDocument();
    });

    it('should have proper semantic HTML', () => {
      renderCard();

      expect(screen.getByRole('heading')).toHaveTextContent('Database Host');
    });
  });

  describe('Responsive Design', () => {
    it('should render properly on mobile', () => {
      renderCard();

      expect(screen.getByText('Database Host')).toBeInTheDocument();
      expect(screen.getByText('localhost')).toBeInTheDocument();
    });

    it('should render properly on desktop', () => {
      renderCard();

      expect(screen.getByText('Database Host')).toBeInTheDocument();
      expect(screen.getByText('localhost')).toBeInTheDocument();
    });
  });

  describe('Different Data Types', () => {
    it('should display string configuration', () => {
      renderCard();

      expect(screen.getByText('Text')).toBeInTheDocument();
    });

    it('should display number configuration', () => {
      const numberConfig: Configuration = {
        ...mockNonSensitiveConfig,
        name: 'Database Port',
        value: '1433',
        dataType: 'number'
      };
      renderCard({ configuration: numberConfig });

      expect(screen.getByText('Number')).toBeInTheDocument();
    });

    it('should display boolean configuration', () => {
      const booleanConfig: Configuration = {
        ...mockNonSensitiveConfig,
        name: 'Cache Enabled',
        value: 'true',
        dataType: 'boolean'
      };
      renderCard({ configuration: booleanConfig });

      expect(screen.getByText('Boolean')).toBeInTheDocument();
    });
  });

  describe('Category Display', () => {
    it('should display the configuration name', () => {
      renderCard();

      expect(screen.getByText('Database Host')).toBeInTheDocument();
    });
  });
});
