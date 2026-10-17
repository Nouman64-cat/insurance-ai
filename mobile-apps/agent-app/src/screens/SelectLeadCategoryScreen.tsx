import React, { useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTheme } from '../theme/ThemeContext';
import { spacing, radii } from '../theme/tokens';
import { entityTone } from '../theme/palette';
import { useResponsive } from '../hooks/useResponsive';
import { EntityType } from '../api/leads';
import { RootStackParamList } from '../navigation/AppNavigator';
import { Screen, ScreenHeader, Text, Card, Pressable, Badge } from '../components/ui';

type NavigationProp = NativeStackNavigationProp<RootStackParamList, 'SelectLeadCategory'>;
type LeadDepth = 'quick' | 'normal';

interface TypeOption {
  type: EntityType;
  title: string;
  description: string;
  icon: keyof typeof Ionicons.glyphMap;
}

const TYPES: TypeOption[] = [
  {
    type: 'INDIVIDUAL',
    title: 'Individual',
    description: 'A single person taking a life or health policy.',
    icon: 'person-outline',
  },
  {
    type: 'FAMILY',
    title: 'Family (Floater)',
    description: 'One policy covering a whole household.',
    icon: 'people-outline',
  },
  {
    type: 'CORPORATE',
    title: 'Corporate',
    description: 'Group health or an enterprise master policy.',
    icon: 'business-outline',
  },
];

const DEPTHS: {
  depth: LeadDepth;
  title: string;
  description: string;
  icon: keyof typeof Ionicons.glyphMap;
  duration: string;
}[] = [
    {
      depth: 'quick',
      title: 'Quick lead',
      description: 'Just a name and a phone number. Capture it now, complete it later.',
      icon: 'timer-outline',
      duration: 'Under a minute',
    },
    {
      depth: 'normal',
      title: 'Full profile',
      description: 'Identity, income, medical and lifestyle — everything underwriting needs.',
      icon: 'document-text-outline',
      duration: '5–10 minutes',
    },
  ];

/**
 * Two-step chooser: entity type, then how much detail to capture. Splitting the
 * decision keeps each screen to one question, and the depth choice is what
 * decides whether the agent faces three fields or thirty.
 */
export default function SelectLeadCategoryScreen() {
  const navigation = useNavigation<NavigationProp>();
  const { colors } = useTheme();
  const { isCompact } = useResponsive();
  const [selectedType, setSelectedType] = useState<EntityType | null>(null);

  const chosen = TYPES.find((t) => t.type === selectedType) ?? null;

  return (
    <Screen
      header={
        <ScreenHeader
          title={chosen ? 'How much detail?' : 'New lead'}
          subtitle={chosen ? chosen.title : 'Step 1 of 2'}
          leading={chosen ? 'back' : 'close'}
          // Backing out of step 2 returns to step 1 rather than leaving entirely.
          onLeadingPress={chosen ? () => setSelectedType(null) : () => navigation.goBack()}
        />
      }
    >
      {!chosen ? (
        <View style={styles.section}>
          <Text variant="title2" style={styles.prompt}>
            What kind of lead is this?
          </Text>
          <Text variant="callout" color="muted" style={styles.promptSub}>
            This decides which underwriting form the lead flows into.
          </Text>

          <View style={styles.options}>
            {TYPES.map((option) => {
              const tone = colors.tone[entityTone[option.type] ?? 'neutral'];
              return (
                <Card
                  key={option.type}
                  onPress={() => setSelectedType(option.type)}
                  padding="lg"
                  accessibilityLabel={`${option.title}. ${option.description}`}
                >
                  <View style={styles.row}>
                    <View
                      style={[
                        styles.iconTile,
                        { backgroundColor: tone.soft, borderColor: tone.softBorder },
                      ]}
                    >
                      <Ionicons name={option.icon} size={26} color={tone.on} />
                    </View>
                    <View style={styles.rowText}>
                      <Text variant="title3">{option.title}</Text>
                      <Text variant="caption" color="muted" style={styles.rowDescription}>
                        {option.description}
                      </Text>
                    </View>
                    <Ionicons name="chevron-forward" size={20} color={colors.textSubtle} />
                  </View>
                </Card>
              );
            })}
          </View>
        </View>
      ) : (
        <View style={styles.section}>
          <Text variant="title2" style={styles.prompt}>
            How much do you know right now?
          </Text>
          <Text variant="callout" color="muted" style={styles.promptSub}>
            A quick lead can be completed later — nothing is lost either way.
          </Text>

          <View style={styles.options}>
            {DEPTHS.map((option) => (
              <Card
                key={option.depth}
                onPress={() =>
                  navigation.navigate('AddLead', { type: chosen.type, category: option.depth })
                }
                padding="lg"
                accessibilityLabel={`${option.title}. ${option.description}`}
              >
                <View style={styles.row}>
                  <View
                    style={[
                      styles.iconTile,
                      {
                        backgroundColor:
                          option.depth === 'quick' ? colors.tone.warning.soft : colors.tone.brand.soft,
                        borderColor:
                          option.depth === 'quick'
                            ? colors.tone.warning.softBorder
                            : colors.tone.brand.softBorder,
                      },
                    ]}
                  >
                    <Ionicons
                      name={option.icon}
                      size={26}
                      color={option.depth === 'quick' ? colors.tone.warning.on : colors.tone.brand.on}
                    />
                  </View>
                  <View style={styles.rowText}>
                    <View style={styles.rowTitleLine}>
                      <Text variant="title3">{option.title}</Text>
                      <Badge
                        label={option.duration}
                        tone={option.depth === 'quick' ? 'warning' : 'brand'}
                        variant="soft"
                        icon="time-outline"
                      />
                    </View>
                    <Text variant="caption" color="muted" style={styles.rowDescription}>
                      {option.description}
                    </Text>
                  </View>
                  {isCompact ? null : (
                    <Ionicons name="chevron-forward" size={20} color={colors.textSubtle} />
                  )}
                </View>
              </Card>
            ))}
          </View>
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  section: {
    paddingTop: spacing.xl,
  },
  prompt: {
    marginBottom: spacing.sm,
  },
  promptSub: {
    marginBottom: spacing.xxl,
  },
  options: {
    gap: spacing.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
  },
  iconTile: {
    width: 54,
    height: 54,
    borderRadius: radii.lg,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowText: {
    flex: 1,
  },
  rowTitleLine: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  rowDescription: {
    marginTop: spacing.xs,
  },
});
