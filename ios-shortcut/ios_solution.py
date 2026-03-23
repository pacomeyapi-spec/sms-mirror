#!/usr/bin/env python3
"""
Générateur de Raccourci iOS pour SMS Mirror.
Ce script génère un fichier .shortcut compatible avec l'app Raccourcis d'Apple.

Fonctionnement iOS :
- iOS interdit aux apps tierces de lire les SMS directement.
- MAIS : avec le Raccourci Siri + l'automatisation, on peut capturer
  les notifications des apps (WhatsApp, etc.) et les transmettre au serveur.
- Pour les SMS natifs : il faut déclencher manuellement le raccourci,
  ou utiliser l'automatisation "Quand je reçois un message" (iOS 17+).

Ce raccourci :
1. Reçoit le contenu d'une notification en entrée
2. L'envoie à votre serveur SMS Mirror
"""

import json
import uuid
import plistlib
import struct

# Configuration à modifier par l'utilisateur
SERVER_URL = "https://VOTRE-SERVEUR.railway.app"
DEVICE_TOKEN = "votre-token-android"
DEVICE_ID = "iphone-" + str(uuid.uuid4())[:8]
DEVICE_NAME = "Mon iPhone"


def build_shortcut():
    """
    Construit le contenu du raccourci iOS au format plist.
    Ce raccourci peut être importé dans l'app Raccourcis d'Apple.
    """

    # Structure d'un raccourci iOS (format WFWorkflow)
    shortcut = {
        "WFWorkflowMinimumClientVersion": 900,
        "WFWorkflowMinimumClientVersionString": "900",
        "WFWorkflowIcon": {
            "WFWorkflowIconStartColor": 463140863,
            "WFWorkflowIconGlyphNumber": 59916
        },
        "WFWorkflowInputContentItemClasses": [
            "WFStringContentItem",
            "WFTextContentItem"
        ],
        "WFWorkflowTypes": ["WFSiriType", "WFMenuBarType"],
        "WFQuickActionSurfaces": [],
        "WFWorkflowActions": [

            # Action 1: Demander entrée (texte du message)
            {
                "WFWorkflowActionIdentifier": "is.workflow.actions.ask",
                "WFWorkflowActionParameters": {
                    "WFAskActionPrompt": "Contenu du message à envoyer :",
                    "WFInputType": "Text",
                    "WFAskActionDefaultAnswer": "",
                    "CustomOutputName": "Contenu"
                }
            },
            # Action 2: Définir variable "contenu"
            {
                "WFWorkflowActionIdentifier": "is.workflow.actions.setvariable",
                "WFWorkflowActionParameters": {
                    "WFVariableName": "contenu"
                }
            },
            # Action 3: Demander expéditeur
            {
                "WFWorkflowActionIdentifier": "is.workflow.actions.ask",
                "WFWorkflowActionParameters": {
                    "WFAskActionPrompt": "Expéditeur (numéro ou nom) :",
                    "WFInputType": "Text",
                    "WFAskActionDefaultAnswer": "",
                    "CustomOutputName": "Expéditeur"
                }
            }
        ]
    }

    return shortcut


if __name__ == "__main__":
    print("Genérateur iOS Shortcut")
