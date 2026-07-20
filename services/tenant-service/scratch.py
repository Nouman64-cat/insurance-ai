import asyncio
import logging
from sqlalchemy.ext.asyncio import create_async_engine
from sqlmodel.ext.asyncio.session import AsyncSession
from sqlmodel import SQLModel
import os
from database import get_session
import uvicorn
from fastapi import FastAPI, Depends
from routers.organizations import delete_organization_employee
from uuid import UUID

# Mock the dependency injection to just test the deletion logic
# Actually, I can just use curl to hit the local server and look at the uvicorn output

